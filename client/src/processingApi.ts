import { MarkdownString } from 'vscode';
import { processingApiData } from './processingApiData';

export interface ApiParam {
	name: string;
	type: string;
}

export interface ApiOverload {
	params: ApiParam[];
	returns: string;
	isStatic?: boolean;
}

/** A function, variable or constant of the Processing API, or a member of one of its classes */
export interface ApiEntry {
	name: string;
	kind: 'method' | 'field' | 'constructor';
	brief?: string;
	description?: string;
	category?: string;
	deprecated?: boolean;
	reference?: boolean;
	// Functions
	overloads?: ApiOverload[];
	params?: Record<string, string>;
	returns?: string;
	callback?: boolean;
	// Variables and constants
	type?: string;
	value?: string;
	usedBy?: string[];
	isStatic?: boolean;
}

export interface ApiClass {
	name: string;
	brief?: string;
	description?: string;
	reference?: boolean;
	members: ApiEntry[];
}

export interface ProcessingApi {
	functions: ApiEntry[];
	variables: ApiEntry[];
	constants: ApiEntry[];
	classes: ApiClass[];
}

const referenceUrl = 'https://processing.org/reference/';

// Pages for the conversion functions don't follow the usual naming
const referencePages: Record<string, string> = {
	int: 'intconvert_',
	float: 'floatconvert_',
	boolean: 'booleanconvert_',
	byte: 'byteconvert_',
	char: 'charconvert_',
};

export const api: ProcessingApi = processingApiData;

export const functions = new Map(api.functions.map((f) => [f.name, f]));
export const variables = new Map(api.variables.map((v) => [v.name, v]));
export const constants = new Map(api.constants.map((c) => [c.name, c]));
export const classes = new Map(api.classes.map((c) => [c.name, c]));

/** Names a sketch can use without a receiver, for de-duplicating the language server's completions */
export const topLevelNames = new Set([...functions.keys(), ...variables.keys(), ...constants.keys(), ...classes.keys()]);

// Classes whose members are inherited from another documented class
const superclasses: Record<string, string> = {
	PGraphics: 'PImage',
};

/** Finds a member of an API class, looking at its documented superclasses too */
export function findMember(className: string, name: string, kind?: ApiEntry['kind']): ApiEntry | undefined {
	for (let current: string | undefined = className; current; current = superclasses[current]) {
		const member = classes.get(current)?.members.find((m) => m.name === name && (!kind || m.kind === kind));
		if (member) {
			return member;
		}
	}
	return undefined;
}

/** A member that only one API class has, for when the receiver's type is unknown */
export function findUniqueMember(name: string, kind?: ApiEntry['kind']): { owner: ApiClass; member: ApiEntry } | undefined {
	const found = api.classes
		.filter((c) => !superclasses[c.name] || !findMember(superclasses[c.name], name, kind))
		.flatMap((owner) => owner.members
			.filter((m) => m.name === name && (!kind || m.kind === kind))
			.map((member) => ({ owner, member })));
	return found.length === 1 ? found[0] : undefined;
}

export function signatureLabel(entry: ApiEntry, overload: ApiOverload): string {
	const params = overload.params.map((p) => `${p.type} ${p.name}`).join(', ');
	return entry.kind === 'constructor'
		? `new ${entry.name}(${params})`
		: `${overload.returns} ${entry.name}(${params})`;
}

/** A short line describing the entry, shown next to completions */
export function detailOf(entry: ApiEntry): string {
	if (entry.overloads) {
		const first = signatureLabel(entry, entry.overloads[0]);
		const more = entry.overloads.length - 1;
		return more > 0 ? `${first} (+${more} overload${more > 1 ? 's' : ''})` : first;
	}
	return `${entry.type} ${entry.name}${entry.value !== undefined ? ` = ${entry.value}` : ''}`;
}

export function referenceLink(entry: ApiEntry | ApiClass, owner?: ApiClass): string | undefined {
	if (!entry.reference) {
		return undefined;
	}
	const isFunction = 'kind' in entry && entry.kind === 'method';
	const page = referencePages[entry.name] && !owner
		? referencePages[entry.name]
		: `${owner ? `${owner.name}_` : ''}${entry.name}${isFunction ? '_' : ''}`;
	return `${referenceUrl}${page}.html`;
}

/** Documentation for completions and hovers */
export function documentationOf(entry: ApiEntry, options: { owner?: ApiClass; signatures?: boolean } = {}): MarkdownString {
	const md = new MarkdownString();
	if (options.signatures) {
		const lines = entry.overloads
			? entry.overloads.slice(0, 8).map((o) => signatureLabel(entry, o))
			: [detailOf(entry)];
		if (entry.overloads && entry.overloads.length > 8) {
			lines.push(`// +${entry.overloads.length - 8} more`);
		}
		if (options.owner) {
			lines.unshift(`// ${options.owner.name}`);
		}
		md.appendCodeblock(lines.join('\n'), 'java');
	}
	if (entry.deprecated) {
		md.appendMarkdown('*Deprecated*\n\n');
	}
	const text = entry.description || entry.brief;
	if (text) {
		md.appendMarkdown(text);
		md.appendMarkdown('\n\n');
	}
	if (entry.params && entry.overloads) {
		const used = new Set(entry.overloads.flatMap((o) => o.params.map((p) => p.name)));
		const params = Object.entries(entry.params).filter(([name]) => used.has(name));
		if (params.length) {
			md.appendMarkdown(params.map(([name, doc]) => `*@param* \`${name}\` ${doc}`).join('\n\n'));
			md.appendMarkdown('\n\n');
		}
	}
	if (entry.returns) {
		md.appendMarkdown(`*@return* ${entry.returns}\n\n`);
	}
	if (entry.usedBy) {
		md.appendMarkdown(`Used with ${entry.usedBy.map((name) => `\`${name}()\``).join(', ')}\n\n`);
	}
	const link = referenceLink(entry, options.owner);
	if (link) {
		md.appendMarkdown(`[Reference](${link})`);
	}
	return md;
}

export function classDocumentation(entry: ApiClass, signatures = false): MarkdownString {
	const md = new MarkdownString();
	if (signatures) {
		md.appendCodeblock(`class ${entry.name}`, 'java');
	}
	const text = entry.description || entry.brief;
	if (text) {
		md.appendMarkdown(text);
		md.appendMarkdown('\n\n');
	}
	const link = referenceLink(entry);
	if (link) {
		md.appendMarkdown(`[Reference](${link})`);
	}
	return md;
}
