/**
 * Reads the structure of a sketch's code well enough for editor features:
 * where its comments, strings and calls are, and what it declares. It isn't
 * a parser, just enough of one to tell a call from a declaration.
 *
 * Providers ask about the same version of a sketch over and over, so results
 * are cached for the last text they were computed from.
 */

/**
 * Remembers a function's result for the last text it got, which is enough as
 * every provider asks about the version of the sketch that's open
 */
export function cacheLast<T>(compute: (text: string) => T): (text: string) => T {
	let lastText: string | undefined;
	let last: T;
	return (text) => {
		if (text !== lastText) {
			last = compute(text);
			lastText = text;
		}
		return last;
	};
}

// ---- Comments and strings

interface Skipped {
	start: number;
	end: number;
	isComment: boolean;
	/** Whether it runs to the end of the line or text without a closing delimiter, like a `//` comment */
	isOpen: boolean;
}

/** The comment or string literal starting at `i`, if one does */
function skipCommentOrString(text: string, i: number): Skipped | undefined {
	const c = text[i];
	const next = text[i + 1];
	if (c === '/' && next === '/') {
		const end = text.indexOf('\n', i);
		return { start: i, end: end < 0 ? text.length : end, isComment: true, isOpen: true };
	}
	if (c === '/' && next === '*') {
		const end = text.indexOf('*/', i + 2);
		return end < 0
			? { start: i, end: text.length, isComment: true, isOpen: true }
			: { start: i, end: end + 2, isComment: true, isOpen: false };
	}
	if (c === '"' || c === '\'') {
		let j = i + 1;
		while (j < text.length && text[j] !== c && text[j] !== '\n') {
			j += text[j] === '\\' ? 2 : 1;
		}
		return text[j] === c
			? { start: i, end: j + 1, isComment: false, isOpen: false }
			: { start: i, end: Math.min(j, text.length), isComment: false, isOpen: true };
	}
	return undefined;
}

/** Every comment and string literal, in order */
const commentsAndStrings = cacheLast((text: string): Skipped[] => {
	const spans: Skipped[] = [];
	for (let i = 0; i < text.length;) {
		const skipped = skipCommentOrString(text, i);
		if (skipped) {
			spans.push(skipped);
			i = skipped.end;
		} else {
			i++;
		}
	}
	return spans;
});

/** Whether an offset is inside a comment or string, which an open one is up to its very end */
function contains(span: Skipped, offset: number): boolean {
	return span.end > offset || span.isOpen && span.end >= offset;
}

/** The last comment or string starting before an offset, the only one that can contain it */
function spanBefore(text: string, offset: number): Skipped | undefined {
	const spans = commentsAndStrings(text);
	let low = 0;
	let high = spans.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (spans[middle].start < offset) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	return spans[low - 1];
}

/** Whether an offset is in a comment or a string literal */
export function isInCommentOrString(text: string, offset: number): boolean {
	const span = spanBefore(text, offset);
	return !!span && contains(span, offset);
}

/** The text with its comments blanked out, keeping offsets the same */
export const withoutComments = cacheLast((text: string): string => {
	let code = '';
	let copied = 0;
	for (const span of commentsAndStrings(text)) {
		if (span.isComment) {
			code += text.slice(copied, span.start) + text.slice(span.start, span.end).replace(/[^\n]/g, ' ');
			copied = span.end;
		}
	}
	return code + text.slice(copied);
});

// ---- Calls

export interface Call {
	name: string;
	/** Where its opening parenthesis is */
	start: number;
	/** Which argument an offset is in, for the call enclosing it */
	argument: number;
	isConstructor: boolean;
	hasReceiver: boolean;
	receiver?: string;
}

export interface Span {
	start: number;
	end: number;
}

/** Words followed by a parenthesis that don't call anything */
const notCalls = new Set(['if', 'for', 'while', 'switch', 'catch', 'synchronized', 'return', 'super', 'this']);

/** Words that can come right before a name without being its type */
export const keywords = new Set(['return', 'new', 'else', 'case', 'throw', 'import', 'package', 'instanceof']);

/** How far before its parenthesis a call's name and receiver are looked for */
const callLookback = 200;

/**
 * The name right before a parenthesis, with what comes before it: `new Name`,
 * `receiver.name`, `.name` (after a call or an index) or just `name`
 */
const callName = /(?:(new)\s+|([A-Za-z_]\w*)\s*\.\s*|(\.)\s*|)([A-Za-z_]\w*)\s*$/;

/**
 * A type right before a name on the same line, which makes it a declaration
 * like `void draw(` or `PVector[] points(`. A comment ending the line before
 * isn't taken for a type.
 */
const typeBeforeName = /([A-Za-z_][\w.]*)(?:<[^<>;\n]*>)?(?:[ \t]*\[[ \t]*\])*[ \t]+$/;

/** The call whose argument list opens at `paren`, if the parenthesis is a call's */
export function callAt(text: string, paren: number, argument: number): Call | undefined {
	const before = text.slice(Math.max(0, paren - callLookback), paren);
	const m = before.match(callName);
	if (!m || notCalls.has(m[4])) {
		return undefined;
	}
	const [, isNew, receiver, isMemberOfExpression, name] = m;
	if (!isNew && !receiver && !isMemberOfExpression) {
		const type = before.slice(0, m.index).match(typeBeforeName);
		if (type && !keywords.has(type[1])) {
			return undefined;
		}
	}
	return {
		name,
		start: paren,
		argument,
		isConstructor: !!isNew,
		hasReceiver: !!(receiver || isMemberOfExpression),
		receiver
	};
}

interface OpenCall {
	paren: number;
	args: Span[];
	argStart: number;
}

/**
 * Walks the parentheses from one offset to another, collecting the calls that
 * close in between and the ones still open at the end. The start has to be
 * outside of comments and strings.
 */
function scanCalls(text: string, from: number, to: number): { calls: { call: Call; args: Span[] }[]; open: OpenCall[] } {
	const calls: { call: Call; args: Span[] }[] = [];
	const open: OpenCall[] = [];
	const spans = commentsAndStrings(text);
	let nextSpan = spans.findIndex((span) => span.start >= from);
	const addArgument = (call: OpenCall, end: number) => {
		let start = call.argStart;
		while (start < end && /\s/.test(text[start])) {
			start++;
		}
		while (end > start && /\s/.test(text[end - 1])) {
			end--;
		}
		call.args.push({ start, end });
	};
	for (let i = from; i < to; i++) {
		if (nextSpan >= 0 && nextSpan < spans.length && spans[nextSpan].start === i) {
			i = spans[nextSpan++].end - 1;
			continue;
		}
		const c = text[i];
		if (c === '(') {
			open.push({ paren: i, args: [], argStart: i + 1 });
		} else if (c === ',' && open.length) {
			const call = open[open.length - 1];
			addArgument(call, i);
			call.argStart = i + 1;
		} else if (c === ')' && open.length) {
			const closed = open.pop()!;
			if (closed.args.length || /\S/.test(text.slice(closed.argStart, i))) {
				addArgument(closed, i);
			}
			const call = callAt(text, closed.paren, closed.args.length);
			if (call) {
				calls.push({ call, args: closed.args });
			}
		} else if ((c === ';' || c === '{' || c === '}') && open.length) {
			// Statements don't continue inside a call (lambdas and anonymous classes aside)
			open.length = 0;
		}
	}
	return { calls, open };
}

/** Every complete call in the text, with the trimmed span of each argument */
export const findCalls = cacheLast((text: string) => scanCalls(text, 0, text.length).calls);

/** How far before an offset to look for the call enclosing it */
const enclosingLookback = 5000;

/** Finds the call whose parentheses contain the offset, and which argument the offset is in */
export function findEnclosingCall(text: string, offset: number): Call | undefined {
	if (isInCommentOrString(text, offset)) {
		return undefined;
	}
	// Start outside of any comment or string the lookback lands in
	let from = Math.max(0, offset - enclosingLookback);
	const span = spanBefore(text, from);
	if (span && span.end > from) {
		from = span.end;
	}
	const innermost = scanCalls(text, from, offset).open.pop();
	return innermost && callAt(text, innermost.paren, innermost.args.length);
}

// ---- Declarations

/** A declaration of a variable, like `PImage img =`, `int[] xs;`, `(PVector v,` or `for (Ball b :` */
const declarationOf = (variable: string) =>
	new RegExp(`\\b([A-Za-z_][\\w.]*)(?:<[^<>;]*>)?(?:\\s*\\[\\s*\\])*\\s+${variable}\\b\\s*(?:[=;,)\\[:]|$)`, 'gm');

/** A declaration of a function or variable, like `void draw(` or `float x =`, but not `return x;` */
const declarationNamed = (name: string) =>
	new RegExp(`\\b(?!return\\b|new\\b|else\\b)[A-Za-z_][\\w.]*(?:<[^<>;]*>)?(?:\\[\\])*\\s+${name}\\s*[(=;,)]`);

/** The declarations of each variable looked up in a sketch, with the offset and type of each */
const declarationsIn = cacheLast(() => new Map<string, { index: number; type: string }[]>());

/** The type in the nearest declaration of a variable before the offset, like `PImage img` */
export function declaredType(text: string, variable: string, before: number): string | undefined {
	const known = declarationsIn(text);
	let declarations = known.get(variable);
	if (!declarations) {
		const code = withoutComments(text);
		declarations = code.includes(variable)
			? [...code.matchAll(declarationOf(variable))]
				.filter((m) => !keywords.has(m[1]))
				.map((m) => ({ index: m.index!, type: m[1].split('.').pop()! }))
			: [];
		known.set(variable, declarations);
	}
	// The last one before the offset, or the first one when it's declared later, like a field
	const earlier = declarations.filter((d) => d.index < before);
	return (earlier[earlier.length - 1] ?? declarations[0])?.type;
}

/** The names looked up in a sketch, with whether it declares each */
const declaredNamesIn = cacheLast(() => new Map<string, boolean>());

/** Whether the sketch declares its own function or variable with this name */
export function isDeclaredInSketch(text: string, name: string): boolean {
	const known = declaredNamesIn(text);
	let declared = known.get(name);
	if (declared === undefined) {
		const code = withoutComments(text);
		declared = code.includes(name) && declarationNamed(name).test(code);
		known.set(name, declared);
	}
	return declared;
}
