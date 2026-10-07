#!/usr/bin/env node
/* global process, console */
/**
 * Generates client/src/processingApiData.ts, the documentation used for
 * completions, hovers and signature help of the Processing API.
 *
 * It reads the Javadoc in a checkout of processing4's core library (the same
 * comments the online reference is built from), so it stays LGPL like the
 * rest of Processing.
 *
 * Usage: node scripts/generateProcessingApi.mjs <path to processing4 checkout>
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = process.argv[2];
if (!root) {
	console.error('Usage: node scripts/generateProcessingApi.mjs <processing4 checkout>');
	process.exit(1);
}
const core = path.join(root, 'core', 'src', 'processing');
const read = (file) => fs.readFileSync(path.join(core, file), 'utf8');

// Classes whose members get documentation after a `.`
const classFiles = {
	PVector: 'core/PVector.java',
	PImage: 'core/PImage.java',
	PGraphics: 'core/PGraphics.java',
	PShape: 'core/PShape.java',
	PFont: 'core/PFont.java',
	IntList: 'data/IntList.java',
	FloatList: 'data/FloatList.java',
	StringList: 'data/StringList.java',
	IntDict: 'data/IntDict.java',
	FloatDict: 'data/FloatDict.java',
	StringDict: 'data/StringDict.java',
	Table: 'data/Table.java',
	TableRow: 'data/TableRow.java',
	XML: 'data/XML.java',
	JSONObject: 'data/JSONObject.java',
	JSONArray: 'data/JSONArray.java',
};

/**
 * Splits a Java source file into the declarations at the top level of its
 * main type, each with the Javadoc and section comment in front of it.
 */
function scanMembers(src) {
	const members = [];
	let classDoc;
	let depth = 0;
	let doc;
	let section;
	let stmt = '';
	let i = 0;

	const flush = (bodyFollows) => {
		const text = stmt.replace(/\s+/g, ' ').trim();
		if (depth === 1 && text) {
			members.push({ text, doc, section, bodyFollows });
		} else if (depth === 0 && /\b(class|interface)\b/.test(text) && classDoc === undefined) {
			classDoc = doc;
		}
		stmt = '';
		doc = undefined;
	};

	while (i < src.length) {
		const c = src[i];
		const next = src[i + 1];
		if (c === '/' && next === '*') {
			const found = src.indexOf('*/', i + 2);
			const end = found < 0 ? src.length : found;
			if (src[i + 2] === '*' && depth <= 1) {
				doc = src.slice(i + 3, end);
			}
			i = end + 2;
			continue;
		}
		if (c === '/' && next === '/') {
			const found = src.indexOf('\n', i);
			const end = found < 0 ? src.length : found;
			const comment = src.slice(i + 2, end).trim();
			if (depth === 1 && !stmt.trim() && /^[a-z][\w ,/&()-]*$/i.test(comment) && comment.length < 50) {
				section = comment;
			}
			i = end;
			continue;
		}
		if (c === '"' || c === '\'') {
			let j = i + 1;
			while (j < src.length && src[j] !== c) {
				j += src[j] === '\\' ? 2 : 1;
			}
			if (depth === 1) {
				stmt += src.slice(i, j + 1);
			}
			i = j + 1;
			continue;
		}
		if (c === '{') {
			if (depth === 1 && /=\s*$|=\s*new\b[^;]*$/.test(stmt)) {
				// Array initializer of a field, skip to the end of it
				let d = 0;
				let j = i;
				do {
					if (src[j] === '{') { d++; }
					if (src[j] === '}') { d--; }
					j++;
				} while (d > 0);
				stmt += '{...}';
				i = j;
				continue;
			}
			if (depth <= 1) {
				flush(true);
			}
			depth++;
		} else if (c === '}') {
			depth--;
			if (depth <= 1) {
				stmt = '';
				doc = undefined;
			}
		} else if (c === ';' && depth === 1) {
			flush(false);
		} else if (depth <= 1) {
			stmt += c;
		}
		i++;
	}
	return { classDoc, members };
}

const modifierRe = /^(?:(?:@\w+(?:\([^)]*\))?|public|protected|private|static|final|synchronized|abstract|native|default|transient|volatile)\s+)*/;

function parseDeclaration(text, inInterface, className) {
	const modifiers = text.match(modifierRe)[0];
	const isPublic = inInterface || /\bpublic\b/.test(modifiers);
	const isStatic = inInterface || /\bstatic\b/.test(modifiers);
	const deprecated = /@Deprecated/.test(modifiers);
	const rest = text.slice(modifiers.length).replace(/^<[^>]+>\s*/, '');
	if (/^(class|interface|enum|record)\b/.test(rest)) {
		return undefined;
	}
	const method = rest.match(/^([\w.<>[\], ?]+?)\s+(\w+)\s*\((.*)\)\s*(?:throws [\w., ]+)?$/);
	if (method) {
		return {
			kind: 'method', name: method[2], returns: method[1].trim(),
			params: parseParams(method[3]), isPublic, isStatic, deprecated
		};
	}
	const constructor = rest.match(/^(\w+)\s*\((.*)\)\s*(?:throws [\w., ]+)?$/);
	if (constructor && constructor[1] === className) {
		return {
			kind: 'constructor', name: className, returns: className,
			params: parseParams(constructor[2]), isPublic, isStatic, deprecated
		};
	}
	const field = rest.match(/^([\w.<>[\]]+)\s+(\w+(?:\s*\[\])?)\s*(?:=\s*(.*))?$/);
	if (field && !rest.includes('(') || field && rest.indexOf('=') < rest.indexOf('(')) {
		return {
			kind: 'field', name: field[2].replace(/\W/g, ''), type: field[1],
			value: field[3]?.trim(), isPublic, isStatic, deprecated
		};
	}
	return undefined;
}

function parseParams(text) {
	text = text.trim();
	if (!text) {
		return [];
	}
	// Split on commas outside of generics
	const parts = [];
	let depth = 0;
	let current = '';
	for (const ch of text) {
		if (ch === '<') { depth++; }
		if (ch === '>') { depth--; }
		if (ch === ',' && depth === 0) {
			parts.push(current);
			current = '';
		} else {
			current += ch;
		}
	}
	parts.push(current);
	return parts.map((p) => {
		const clean = p.replace(/@\w+\s+/g, '').replace(/\bfinal\s+/, '').trim();
		const m = clean.match(/^(.*?)\s*(\w+)$/);
		return { type: m[1].replace(/\s+/g, ''), name: m[2] };
	});
}

/** Turns Javadoc HTML into Markdown */
function toMarkdown(html) {
	return html
		.replace(/\{@link(?:plain)?\s+[\w.]*#?(\w+)(?:\([^)]*\))?(?:\s+([^}]*))?\}/g, (_, name, label) => `\`${label || name}\``)
		.replace(/\{@code\s+([^}]*)\}/g, '`$1`')
		.replace(/<\/?(?:b|strong)>/gi, '**')
		.replace(/<\/?(?:i|em)>/gi, '*')
		.replace(/<\/?(?:code|tt|kbd)>/gi, '`')
		.replace(/<br\s*\/?>\s*/gi, '\n')
		.replace(/<\/?p\s*\/?>\s*/gi, '\n\n')
		.replace(/<li>\s*/gi, '\n- ')
		.replace(/<a [^>]*>(.*?)<\/a>/gi, '$1')
		.replace(/<[^>]+>/g, '')
		.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
		.replace(/\*\*\s*\*\*/g, '')
		.replace(/[ \t]+/g, ' ')
		.replace(/ ?\n ?/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function parseDoc(raw) {
	if (!raw) {
		return {};
	}
	const lines = raw.split('\n').map((l) => l.replace(/^\s*\*? ?/, ''));
	const text = lines.join('\n');
	const tagStart = text.search(/^@\w+/m);
	const description = tagStart >= 0 ? text.slice(0, tagStart) : text;
	const result = { description: toMarkdown(description), params: {} };
	const tags = tagStart >= 0 ? text.slice(tagStart).split(/\n(?=@\w+)/) : [];
	for (const tag of tags) {
		const m = tag.match(/^@(\w+)\s*([\s\S]*)$/);
		if (!m) { continue; }
		const [, name, body] = m;
		const value = body.replace(/\s+/g, ' ').trim();
		if (name === 'webref') {
			result.webref = value || 'misc';
		} else if (name === 'webBrief' || name === 'brief') {
			result.brief = toMarkdown(value);
		} else if (name === 'param') {
			const p = value.match(/^(\w+)\s*(.*)$/);
			if (p) {
				result.params[p[1]] = toMarkdown(p[2]);
			}
		} else if (name === 'return') {
			result.returns = toMarkdown(value);
		} else if (name === 'nowebref') {
			result.nowebref = true;
		} else if (name === 'deprecated') {
			result.deprecated = toMarkdown(value) || true;
		}
	}
	return result;
}

/** Folds the overloads of each name into one entry */
function collect(members, { inInterface, className, include }) {
	const entries = {};
	for (const member of members) {
		const decl = parseDeclaration(member.text, inInterface, className);
		if (!decl || !decl.isPublic) {
			continue;
		}
		const doc = parseDoc(member.doc);
		const key = decl.kind === 'field' ? `field:${decl.name}` : `method:${decl.name}`;
		let entry = entries[key];
		if (!entry) {
			entry = entries[key] = { kind: decl.kind, name: decl.name, overloads: [], params: {}, section: member.section };
		}
		if (decl.kind === 'field') {
			entry.type = decl.type;
			entry.value = decl.value;
			entry.isStatic = decl.isStatic;
		} else {
			entry.overloads.push({
				params: decl.params, returns: decl.returns,
				...(decl.isStatic ? { isStatic: true } : {}),
				...(decl.deprecated || doc.deprecated ? { deprecated: true } : {})
			});
		}
		Object.assign(entry.params, Object.fromEntries(Object.entries(doc.params || {}).filter(([k]) => !entry.params[k])));
		// The documented overload (the one in the online reference) wins
		const better = doc.webref && !entry.webref || (doc.description && !entry.description);
		if (better) {
			entry.description = doc.description;
			entry.brief = doc.brief;
			entry.returnsDoc = doc.returns;
		}
		entry.webref = entry.webref || doc.webref;
		entry.deprecated = entry.deprecated ?? (decl.deprecated || doc.deprecated);
		if (decl.deprecated || doc.deprecated) {
			entry.anyDeprecated = true;
		} else {
			entry.anyCurrent = true;
		}
	}
	return Object.values(entries).filter((e) => include(e)).map((e) => {
		const out = {
			name: e.name,
			kind: e.kind,
			...(e.brief ? { brief: e.brief } : {}),
			...(e.description ? { description: e.description } : {}),
			...(e.webref ? { category: e.webref } : e.section ? { category: e.section } : {}),
			...(e.anyCurrent ? {} : { deprecated: true }),
			// Has a page in the online reference
			...(e.webref ? { reference: true } : {}),
		};
		if (e.kind === 'field') {
			out.type = e.type;
			if (e.value !== undefined && e.value.length < 60 && e.value !== '{...}') {
				out.value = e.value;
			}
			if (e.isStatic) {
				out.isStatic = true;
			}
		} else {
			// Hide deprecated overloads when there are current ones
			const current = e.overloads.filter((o) => !o.deprecated);
			out.overloads = (current.length ? current : e.overloads).map(({ deprecated: _, ...o }) => o);
			if (Object.keys(e.params).length) {
				out.params = e.params;
			}
			if (e.returnsDoc) {
				out.returns = e.returnsDoc;
			}
		}
		return out;
	});
}

// Callbacks a sketch defines itself; most are in the reference already
const callbacks = new Set([
	'setup', 'draw', 'settings',
	'mousePressed', 'mouseReleased', 'mouseClicked', 'mouseMoved', 'mouseDragged', 'mouseWheel',
	'keyPressed', 'keyReleased', 'keyTyped', 'windowMoved', 'windowResized'
]);

// In the online reference, but without reference Javadoc in PApplet
const undocumented = {
	hint: 'Enables or disables renderer hints, such as ENABLE_DEPTH_SORT or DISABLE_DEPTH_TEST',
	str: 'Converts a value of a primitive data type to its String representation',
	windowTitle: 'Sets the title of the sketch window',
	windowResize: 'Changes the size of the sketch window',
	windowResizable: 'Lets the user resize the sketch window, or stops them from doing so',
	windowMove: 'Moves the sketch window to a position on the screen',
	windowRatio: 'Scales the sketch to fit the window while keeping a fixed coordinate size',
	windowMoved: 'Called every time the sketch window is moved',
	windowResized: 'Called every time the sketch window is resized',
};

// Processing turns int(x) and friends into calls to these PApplet functions
const conversions = {
	int: ['parseInt', 'Converts a value of another primitive type or a String to an int'],
	float: ['parseFloat', 'Converts a value of another primitive type or a String to a float'],
	boolean: ['parseBoolean', 'Converts an int or a String to a boolean'],
	byte: ['parseByte', 'Converts a value of another primitive type to a byte'],
	char: ['parseChar', 'Converts an int or a byte to a char'],
};

// ---- PApplet: the functions and variables a sketch can use directly
const papplet = scanMembers(read('core/PApplet.java'));
const documented = new Set();
for (const m of papplet.members) {
	const decl = parseDeclaration(m.text, false, 'PApplet');
	const doc = parseDoc(m.doc);
	if (decl && decl.isPublic && doc.webref) {
		documented.add(`${decl.kind === 'field' ? 'field' : 'method'}:${decl.name}`);
	}
}
const appletEntries = collect(papplet.members, {
	inInterface: false,
	className: 'PApplet',
	include: (e) => documented.has(`${e.kind === 'field' ? 'field' : 'method'}:${e.name}`) ||
		e.kind === 'method' && (callbacks.has(e.name) || e.name in undocumented)
});
for (const entry of appletEntries) {
	if (entry.kind === 'method' && entry.name in undocumented && !entry.brief) {
		entry.brief = undocumented[entry.name];
		entry.reference = true;
		entry.category = entry.name === 'hint' ? 'rendering' : entry.name === 'str' ? 'data:conversion' : 'environment';
	}
}
const parsers = collect(papplet.members, {
	inInterface: false,
	className: 'PApplet',
	include: (e) => e.kind === 'method' && Object.values(conversions).some(([p]) => p === e.name)
});
for (const [name, [parser, brief]] of Object.entries(conversions)) {
	const source = parsers.find((p) => p.name === parser);
	appletEntries.push({
		name, kind: 'method', brief, category: 'data:conversion', reference: true,
		overloads: source.overloads.filter((o) => o.params.length === 1).map((o) => ({ ...o, isStatic: undefined }))
	});
}
const functions = appletEntries.filter((e) => e.kind === 'method');
const variables = appletEntries.filter((e) => e.kind === 'field');
for (const f of functions) {
	if (callbacks.has(f.name)) {
		f.callback = true;
	}
}

// ---- PConstants: everything a sketch can use as a constant
const pconstants = scanMembers(read('core/PConstants.java'));
const constants = collect(pconstants.members, {
	inInterface: true, className: 'PConstants', include: (e) => e.kind === 'field'
});
// Note which functions mention each constant in their parameter docs, which
// is where the reference documents most of them
const mentions = {};
for (const f of functions) {
	for (const text of Object.values(f.params || {})) {
		for (const word of text.match(/\b[A-Z][A-Z0-9_]+\b/g) || []) {
			(mentions[word] ||= new Set()).add(f.name);
		}
	}
}
for (const c of constants) {
	if (mentions[c.name]) {
		c.usedBy = [...mentions[c.name]].sort();
	}
	delete c.isStatic;
}

// ---- Classes
const classes = [];
for (const [name, file] of Object.entries(classFiles)) {
	const scanned = scanMembers(read(file));
	const doc = parseDoc(scanned.classDoc);
	const members = collect(scanned.members, {
		inInterface: false, className: name,
		include: (e) => !/^[A-Z_0-9]+$/.test(e.name) || e.kind !== 'field'
	});
	classes.push({
		name,
		...(doc.brief ? { brief: doc.brief } : {}),
		...(doc.description ? { description: doc.description } : {}),
		...(doc.webref ? { reference: true } : {}),
		members
	});
}

const api = { functions, variables, constants, classes };
const banner = [
	'// Generated by scripts/generateProcessingApi.mjs from the Javadoc in',
	'// processing4/core. Do not edit by hand; run the script again instead.',
	'',
	'import type { ProcessingApi } from \'./processingApi\';',
	'',
	''
].join('\n');
const outFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'src', 'processingApiData.ts');
fs.writeFileSync(outFile, `${banner}export const processingApiData: ProcessingApi = ${JSON.stringify(api)};\n`);
console.log(`${functions.length} functions, ${variables.length} variables, ${constants.length} constants, ${classes.length} classes -> ${path.relative(process.cwd(), outFile)}`);
