import {
	CancellationToken, CompletionContext, CompletionItem, CompletionItemKind, CompletionItemTag, CompletionList, EventEmitter,
	ExtensionContext, Hover, InlayHint, InlayHintKind, languages, MarkdownString, ParameterInformation, Position, ProviderResult,
	Range, SignatureHelp, SignatureHelpContext, SignatureInformation, SnippetString, TextDocument, workspace
} from 'vscode';
import { ProvideCompletionItemsSignature, ResolveCompletionItemSignature } from 'vscode-languageclient';
import {
	ApiClass, ApiEntry, classDocumentation, classes, constants, detailOf, documentationOf, findMember,
	findUniqueMember, functions, signatureLabel, topLevelNames, variables
} from './processingApi';
import {
	Call, declaredType, findCalls, findEnclosingCall, isDeclaredInSketch, isInCommentOrString
} from './sketchScanner';

/**
 * IntelliSense for the Processing API itself: every function, variable and
 * constant a sketch can use, with documentation, hovers and parameter hints.
 *
 * The language server only completes what it can resolve in a sketch that
 * compiles, without documentation, so its suggestions are merged with these.
 */
const selector = { scheme: 'file', language: 'Processing' };

export function setupProcessingApi(context: ExtensionContext) {
	const inlayHintsChanged = new EventEmitter<void>();
	context.subscriptions.push(
		languages.registerHoverProvider(selector, { provideHover }),
		languages.registerSignatureHelpProvider(selector, { provideSignatureHelp }, {
			triggerCharacters: ['(', ','],
			retriggerCharacters: [')']
		}),
		languages.registerInlayHintsProvider(selector, { provideInlayHints, onDidChangeInlayHints: inlayHintsChanged.event }),
		inlayHintsChanged,
		workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('processing.inlayHints.parameterNames')) {
				inlayHintsChanged.fire();
			}
		})
	);
}

/** Completion middleware for the language client: merges the server's completions with the API's */
export async function provideApiCompletions(
	document: TextDocument,
	position: Position,
	context: CompletionContext,
	token: CancellationToken,
	next: ProvideCompletionItemsSignature
): Promise<CompletionItem[] | CompletionList | undefined> {
	let serverResult: CompletionItem[] | CompletionList | null | undefined;
	try {
		serverResult = await next(document, position, context, token);
	} catch (e) {
		// The server fails on sketches it can't parse, the API completions still work
		console.log(e);
	}
	const serverItems = (Array.isArray(serverResult) ? serverResult : serverResult?.items) ?? [];
	const isIncomplete = !Array.isArray(serverResult) && !!serverResult?.isIncomplete;

	const offset = document.offsetAt(position);
	const text = document.getText();
	if (isInCommentOrString(text, offset)) {
		return serverResult ?? undefined;
	}
	const linePrefix = document.lineAt(position.line).text.slice(0, position.character);

	// After a `.`: document the members the server found
	if (/\.\s*\w*$/.test(linePrefix)) {
		for (const item of serverItems) {
			documentMemberCompletion(item);
		}
		return serverResult ?? undefined;
	}

	// Defining an event function like `void mousePressed`
	if (/^\s*(?:public\s+)?void\s+\w*$/.test(linePrefix)) {
		return new CompletionList([...functions.values()]
			.filter((f) => f.callback)
			.map((f) => {
				const item = functionCompletion(f);
				item.insertText = new SnippetString(`${f.name}() {\n\t$0\n}`);
				item.command = undefined;
				apiItems.add(item);
				return item;
			}));
	}

	// Declaring a variable or a parameter: a new name, nothing to complete
	if (typedName.test(linePrefix) && !keywordThenName.test(linePrefix)) {
		return serverResult ?? undefined;
	}

	const items: CompletionItem[] = [];
	for (const item of serverItems) {
		const label = typeof item.label === 'string' ? item.label : item.label.label;
		const isLocal = item.kind === CompletionItemKind.Variable || item.kind === CompletionItemKind.Field ||
			item.kind === CompletionItemKind.Method;
		if (!isLocal && topLevelNames.has(label)) {
			// Replaced by the documented API item
			continue;
		}
		// Names from the sketch come first, then the API, then everything else the server found
		item.sortText = `${isLocal ? 0 : 2}${label}`;
		items.push(item);
	}
	items.push(...apiCompletions());
	return new CompletionList(items, isIncomplete);
}

/** A type followed by the name being typed, like `float x` or `(PVector v`, which declares it */
const typedName = /(?:^|[(,;{]|\bfinal)\s*[A-Za-z_][\w.]*(?:<[^>]*>)?(?:\[\])*\s+\w*$/;
/** A keyword followed by the name being typed, like `return x`, which looks like a declaration but isn't */
const keywordThenName = /\b(?:return|new|else|case|throw)\s+\w*$/;

/**
 * Completion resolve middleware for the language client: the client sends items back to the server
 * to resolve them, which only works for the server's own items and their documentation formats
 */
export async function resolveApiCompletion(
	item: CompletionItem,
	token: CancellationToken,
	next: ResolveCompletionItemSignature
): Promise<CompletionItem | undefined> {
	if (apiItems.has(item)) {
		// Already complete, the server doesn't know it
		return item;
	}
	const documentation = documentedServerItems.get(item);
	if (!documentation) {
		return (await next(item, token)) ?? undefined;
	}
	// Sending documentation the server didn't create breaks the conversion, add it back afterwards
	item.documentation = undefined;
	try {
		const resolved = (await next(item, token)) ?? item;
		resolved.documentation ??= documentation;
		return resolved;
	} finally {
		item.documentation = documentation;
	}
}

/** Items that aren't the server's, so it can't resolve them */
const apiItems = new WeakSet<CompletionItem>();
/** The server's items documented with the API, which the server doesn't know about */
const documentedServerItems = new WeakMap<CompletionItem, MarkdownString>();

let cachedCompletions: CompletionItem[] | undefined;

function apiCompletions(): CompletionItem[] {
	cachedCompletions ??= [
		...[...functions.values()].map(functionCompletion),
		...[...variables.values()].map((v) => fieldCompletion(v, CompletionItemKind.Variable)),
		...[...constants.values()].map((c) => fieldCompletion(c, CompletionItemKind.Constant)),
		...[...classes.values()].map(classCompletion)
	];
	cachedCompletions.forEach((item) => apiItems.add(item));
	return cachedCompletions;
}

function functionCompletion(entry: ApiEntry): CompletionItem {
	const item = new CompletionItem({ label: entry.name, description: entry.category?.split(':')[0] }, CompletionItemKind.Function);
	item.detail = detailOf(entry);
	item.documentation = documentationOf(entry);
	item.sortText = `1${entry.name}`;
	if (entry.overloads?.every((o) => o.params.length === 0)) {
		item.insertText = new SnippetString(`${entry.name}()`);
	} else {
		item.insertText = new SnippetString(`${entry.name}($0)`);
		item.command = { title: 'Parameter hints', command: 'editor.action.triggerParameterHints' };
	}
	if (entry.deprecated) {
		item.tags = [CompletionItemTag.Deprecated];
	}
	return item;
}

function fieldCompletion(entry: ApiEntry, kind: CompletionItemKind): CompletionItem {
	const item = new CompletionItem({ label: entry.name, description: entry.category?.split(':')[0] }, kind);
	item.detail = detailOf(entry);
	item.documentation = documentationOf(entry);
	item.sortText = `1${entry.name}`;
	if (entry.deprecated) {
		item.tags = [CompletionItemTag.Deprecated];
	}
	return item;
}

function classCompletion(entry: ApiClass): CompletionItem {
	const item = new CompletionItem({ label: entry.name, description: 'class' }, CompletionItemKind.Class);
	item.detail = `class ${entry.name}`;
	item.documentation = classDocumentation(entry);
	item.sortText = `1${entry.name}`;
	return item;
}

/** The server labels members like `add(PVector) : PVector - PVector`, ending with the declaring class */
function documentMemberCompletion(item: CompletionItem) {
	if (item.documentation) {
		return;
	}
	const label = typeof item.label === 'string' ? item.label : item.label.label;
	const owner = item.detail?.match(/ - (\w+)$/)?.[1];
	const member = owner && classes.has(owner)
		? findMember(owner, label)
		: findUniqueMember(label)?.member;
	if (member) {
		item.documentation = documentationOf(member);
		documentedServerItems.set(item, item.documentation);
	}
}

function provideHover(document: TextDocument, position: Position): ProviderResult<Hover> {
	const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
	if (!range) {
		return undefined;
	}
	const text = document.getText();
	const start = document.offsetAt(range.start);
	const end = document.offsetAt(range.end);
	if (isInCommentOrString(text, start)) {
		return undefined;
	}
	const name = text.slice(start, end);
	const before = text.slice(Math.max(0, start - 200), start);
	const isCall = /^\s*\(/.test(text.slice(end, end + 50));

	const receiver = before.match(/([A-Za-z_]\w*)\s*\.\s*$/);
	if (receiver || /\.\s*$/.test(before)) {
		const found = findMemberOf(text, receiver?.[1], name, isCall ? 'method' : 'field', start);
		return found && new Hover(documentationOf(found.member, { owner: found.owner, signatures: true }), range);
	}
	if (/\bnew\s+$/.test(before) && classes.has(name)) {
		const constructor = findMember(name, name, 'constructor');
		return new Hover(constructor
			? documentationOf(constructor, { owner: classes.get(name), signatures: true })
			: classDocumentation(classes.get(name)!, true), range);
	}
	if (hidesApi(text, name)) {
		return undefined;
	}
	const entry = isCall
		? functions.get(name)
		: variables.get(name) ?? constants.get(name) ?? functions.get(name);
	if (entry) {
		return new Hover(documentationOf(entry, { signatures: true }), range);
	}
	const apiClass = classes.get(name);
	return apiClass && new Hover(classDocumentation(apiClass, true), range);
}

function provideSignatureHelp(
	document: TextDocument,
	position: Position,
	_token: CancellationToken,
	context: SignatureHelpContext
): ProviderResult<SignatureHelp> {
	const text = document.getText();
	const offset = document.offsetAt(position);
	const call = findEnclosingCall(text, offset);
	if (!call) {
		return undefined;
	}

	const entry = resolveCall(text, call);
	if (!entry?.overloads?.length) {
		return undefined;
	}

	const help = new SignatureHelp();
	help.signatures = entry.overloads.map((overload) => {
		const signature = new SignatureInformation(signatureLabel(entry, overload), new MarkdownString(entry.brief ?? ''));
		signature.parameters = overload.params.map((p) => new ParameterInformation(
			`${p.type} ${p.name}`,
			entry.params?.[p.name] ? new MarkdownString(entry.params[p.name]) : undefined
		));
		return signature;
	});
	// Keep the overload the user picked while it still fits, otherwise the first one that does
	const previous = context.activeSignatureHelp?.activeSignature;
	const fits = (i: number) => entry.overloads![i].params.length > call.argument ||
		(call.argument === 0 && entry.overloads![i].params.length === 0);
	help.activeSignature = previous !== undefined && previous < help.signatures.length && fits(previous)
		? previous
		: Math.max(0, entry.overloads.findIndex((_, i) => fits(i)));
	help.activeParameter = call.argument;
	return help;
}

/** Labels the arguments of API calls with their parameter names, like `ellipse(x: 50, y: 50, …)` */
function provideInlayHints(document: TextDocument, range: Range): InlayHint[] {
	if (!workspace.getConfiguration('processing', document).get('inlayHints.parameterNames', true)) {
		return [];
	}
	const text = document.getText();
	const from = document.offsetAt(range.start);
	const to = document.offsetAt(range.end);
	const hints: InlayHint[] = [];
	for (const { call, args } of findCalls(text)) {
		if (call.start > to || !args.length || args[args.length - 1].end < from) {
			continue;
		}
		// `PVector.add(a, b)` is the static method, `v.add(x, y)` isn't
		const isStatic = call.receiver === undefined ? undefined : classes.has(call.receiver);
		const names = parameterNames(resolveCall(text, call), args.length, isStatic);
		args.forEach((arg, i) => {
			const name = names[i];
			const argument = text.slice(arg.start, arg.end);
			if (!name || arg.start < from || arg.start > to || isNamedLike(argument, name)) {
				return;
			}
			const hint = new InlayHint(document.positionAt(arg.start), `${name}:`, InlayHintKind.Parameter);
			hint.paddingRight = true;
			hints.push(hint);
		});
	}
	return hints;
}

/**
 * The parameter names for a call with this many arguments. When overloads
 * with that many parameters name them differently, like `fill(int rgb)` and
 * `fill(float gray)`, those arguments get no name.
 */
function parameterNames(entry: ApiEntry | undefined, argumentCount: number, isStatic?: boolean): (string | undefined)[] {
	const overloads = (entry?.overloads ?? []).filter((o) => isStatic === undefined || !!o.isStatic === isStatic);
	const candidates = overloads.map((o) => o.params).filter((params) => {
		const isVariadic = params[params.length - 1]?.type.endsWith('...');
		return isVariadic ? argumentCount >= params.length - 1 : argumentCount === params.length;
	});
	return Array.from({ length: argumentCount }, (_, i) => {
		const names = new Set(candidates.map((params) => {
			const param = params[Math.min(i, params.length - 1)];
			// Only the first of the variadic arguments is labeled
			return i < params.length ? param?.name : param?.type.endsWith('...') ? '' : undefined;
		}));
		const [name] = names;
		return names.size === 1 && name ? name : undefined;
	});
}

/** Whether an argument already says what it is, like `x` or `this.x` for a parameter named `x` */
function isNamedLike(argument: string, name: string): boolean {
	const last = argument.match(/^[\w.]*?(\w+)$/)?.[1];
	return last?.toLowerCase() === name.toLowerCase();
}

/** The API function, method or constructor a call refers to */
function resolveCall(text: string, call: Call): ApiEntry | undefined {
	if (call.isConstructor) {
		return classes.has(call.name) ? findMember(call.name, call.name, 'constructor') : undefined;
	}
	if (call.hasReceiver) {
		return findMemberOf(text, call.receiver, call.name, 'method', call.start)?.member;
	}
	return hidesApi(text, call.name) ? undefined : functions.get(call.name);
}

/** Whether the sketch defines its own function or variable with this name, which hides the API's */
function hidesApi(text: string, name: string): boolean {
	// Event functions like `void draw()` are the API's, meant to be defined by the sketch
	return !functions.get(name)?.callback && isDeclaredInSketch(text, name);
}

/**
 * Looks up a member of an API class. The receiver's type comes from its
 * declaration in the sketch when there is one, like `PVector v`, otherwise
 * the member has to be unique to one class.
 */
function findMemberOf(text: string, receiver: string | undefined, name: string, kind: ApiEntry['kind'], before: number)
	: { owner: ApiClass; member: ApiEntry } | undefined {
	if (receiver) {
		const type = classes.has(receiver) ? receiver : declaredType(text, receiver, before);
		if (type && classes.has(type)) {
			const member = findMember(type, name, kind) ?? findMember(type, name);
			return member && { owner: classes.get(type)!, member };
		}
		if (type) {
			// A class the API doesn't document
			return undefined;
		}
	}
	return findUniqueMember(name, kind) ?? findUniqueMember(name);
}
