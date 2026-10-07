import { Color, ColorInformation, ColorPresentation, ExtensionContext, languages, Range, TextEdit } from 'vscode';
import { cacheLast, callAt, findCalls, isInCommentOrString, Span } from './sketchScanner';

/**
 * Color swatches and a color picker for the colors in a sketch, like
 * `fill(255, 0, 0)`, `stroke(#FF8800)` or `color c = #336699`.
 *
 * Picking a color keeps the way it was written where it can: a hex code
 * stays a hex code, and a gray stays a gray until the color isn't one.
 */
const selector = { scheme: 'file', language: 'Processing' };

/** Functions that take a color as gray, RGB values or a hex code, with whether they take an alpha too */
const colorFunctions = new Map([
	['background', true], ['fill', true], ['stroke', true], ['tint', true], ['color', true],
	['ambient', false], ['emissive', false], ['specular', false]
]);

export function setupColorPicker(context: ExtensionContext) {
	context.subscriptions.push(languages.registerColorProvider(selector, {
		provideDocumentColors: (document) => colorsIn(document.getText()).map((found) =>
			new ColorInformation(new Range(document.positionAt(found.start), document.positionAt(found.end)), found.color)),
		// Called for every step of dragging in the picker, so only reads around the color
		provideColorPresentations: (color, { document, range }) => {
			const found = colorAt(document.getText(), document.offsetAt(range.start), document.offsetAt(range.end));
			return found && presentations(found, color).map((text) => {
				const presentation = new ColorPresentation(text);
				presentation.textEdit = TextEdit.replace(range, text);
				return presentation;
			});
		}
	}));
}

/** How a color is written */
interface FoundColor extends Span {
	color: Color;
	/** `#RRGGBB`, `0xAARRGGBB`, a gray value or RGB values */
	form: 'web' | 'hex' | 'gray' | 'rgb';
	/** Whether the alpha is a separate argument */
	hasAlphaArgument: boolean;
	/** Whether more arguments can be added, which a bare `#RRGGBB` outside a call can't */
	isArguments: boolean;
	canHaveAlpha: boolean;
	/** The `0x` or `#` prefix and the hex digits' case as written */
	prefix: string;
	lowercase: boolean;
	ranges?: ColorRanges;
}

/** The maximum of red, green, blue and alpha values, set with `colorMode(RGB, …)` */
type ColorRanges = [number, number, number, number];

const webHex = /^#[0-9A-Fa-f]{6}$/;
const argbHex = /^0[xX][0-9A-Fa-f]{8}$/;
/** A `#RRGGBB` anywhere, like `color c = #336699;` */
const webHexInCode = /(?<![\w#])#[0-9A-Fa-f]{6}(?!\w)/g;

/** The colors written in a sketch: the arguments of color functions, and hex codes elsewhere */
const colorsIn = cacheLast((text: string): FoundColor[] => {
	const ranges = colorRangesIn(text);
	const found: FoundColor[] = [];
	for (const { call, args } of findCalls(text)) {
		const canHaveAlpha = colorFunctions.get(call.name);
		if (canHaveAlpha === undefined || call.isConstructor || !args.length) {
			continue;
		}
		const color = parseColor(args.map((a) => text.slice(a.start, a.end)), ranges, canHaveAlpha);
		if (color) {
			found.push({ ...color, start: args[0].start, end: args[args.length - 1].end, isArguments: true, canHaveAlpha });
		}
	}
	// A hex code can only be inside a color's arguments as the first one
	const inArguments = new Set(found.map((f) => f.start));
	for (const m of text.matchAll(webHexInCode)) {
		const start = m.index!;
		if (!inArguments.has(start) && !isInCommentOrString(text, start)) {
			found.push(bareHex(m[0], start, ranges));
		}
	}
	return found;
});

/** The color written between two offsets, read from around it rather than the whole sketch */
function colorAt(text: string, start: number, end: number): FoundColor | undefined {
	const ranges = colorRangesIn(text);
	const written = text.slice(start, end);
	const paren = lastNonSpace(text, start);
	if (text[paren] === '(' && text[firstNonSpace(text, end)] === ')') {
		const call = callAt(text, paren, 0);
		const canHaveAlpha = call && !call.isConstructor ? colorFunctions.get(call.name) : undefined;
		if (canHaveAlpha !== undefined) {
			const color = parseColor(written.split(',').map((arg) => arg.trim()), ranges, canHaveAlpha);
			return color && { ...color, start, end, isArguments: true, canHaveAlpha };
		}
	}
	return webHex.test(written) ? bareHex(written, start, ranges) : undefined;
}

function bareHex(written: string, start: number, ranges: ColorRanges | undefined): FoundColor {
	return { ...parseColor([written], ranges, true)!, start, end: start + written.length, isArguments: false, canHaveAlpha: true };
}

function lastNonSpace(text: string, before: number): number {
	let i = before - 1;
	while (i >= 0 && /\s/.test(text[i])) {
		i--;
	}
	return i;
}

function firstNonSpace(text: string, from: number): number {
	let i = from;
	while (i < text.length && /\s/.test(text[i])) {
		i++;
	}
	return i;
}

/** A `colorMode(` call, with its arguments up to the closing parenthesis */
const colorModeCall = /\bcolorMode\s*\(([^()]*)\)?/g;

/**
 * The value ranges all of the sketch's `colorMode()` calls agree on, or undefined
 * when they don't, use HSB or can't be read, as numbers can't be read as colors then
 */
const colorRangesIn = cacheLast((text: string): ColorRanges | undefined => {
	let ranges: ColorRanges | undefined;
	for (const m of text.matchAll(colorModeCall)) {
		if (isInCommentOrString(text, m.index!)) {
			continue;
		}
		if (m[1] === undefined || text[m.index! + m[0].length - 1] !== ')') {
			// Arguments with calls in them
			return undefined;
		}
		const next = colorModeRanges(m[1].split(',').map((arg) => arg.trim()));
		if (!next || ranges && next.some((v, j) => v !== ranges![j])) {
			return undefined;
		}
		ranges = next;
	}
	return ranges ?? [255, 255, 255, 255];
});

/** The ranges one `colorMode()` call sets, if it's RGB with numbers */
function colorModeRanges([mode, ...maxes]: string[]): ColorRanges | undefined {
	const values = maxes.map(parseNumber);
	if (mode !== 'RGB' || values.some((v) => v === undefined || v <= 0)) {
		return undefined;
	}
	if (values.length === 1) {
		return [values[0]!, values[0]!, values[0]!, values[0]!];
	}
	if (values.length >= 3) {
		return [values[0]!, values[1]!, values[2]!, values[3] ?? 255];
	}
	return [255, 255, 255, 255];
}

function parseNumber(text: string): number | undefined {
	return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fFdD]?$/.test(text) ? parseFloat(text) : undefined;
}

function parseColor(args: string[], ranges: ColorRanges | undefined, canHaveAlpha: boolean)
	: Omit<FoundColor, 'start' | 'end' | 'isArguments' | 'canHaveAlpha'> | undefined {
	const [first, ...rest] = args;
	const numbers = args.map(parseNumber);
	const unit = (value: number, max: number) => Math.min(1, Math.max(0, value / max));

	if (webHex.test(first) || argbHex.test(first)) {
		const isWeb = first.startsWith('#');
		const written = first.slice(isWeb ? 1 : 2);
		const digits = isWeb ? `FF${written}` : written;
		const [a, r, g, b] = [0, 2, 4, 6].map((i) => parseInt(digits.slice(i, i + 2), 16) / 255);
		if (rest.length > 1 || rest.length && (!canHaveAlpha || !ranges || numbers[1] === undefined)) {
			return undefined;
		}
		return {
			color: new Color(r, g, b, rest.length ? unit(numbers[1]!, ranges![3]) : a),
			form: isWeb ? 'web' : 'hex',
			hasAlphaArgument: rest.length > 0,
			prefix: isWeb ? '#' : first.slice(0, 2),
			lowercase: /[a-f]/.test(written) && !/[A-F]/.test(written),
			ranges
		};
	}
	if (!ranges || numbers.some((n) => n === undefined) || args.length > (canHaveAlpha ? 4 : 3)) {
		return undefined;
	}
	const [rMax, gMax, bMax, aMax] = ranges;
	if (args.length <= 2) {
		// A gray is in the red range, like Processing reads it
		const gray = unit(numbers[0]!, rMax);
		return {
			color: new Color(gray, gray, gray, args.length === 2 ? unit(numbers[1]!, aMax) : 1),
			form: 'gray', hasAlphaArgument: args.length === 2, prefix: '', lowercase: false, ranges
		};
	}
	return {
		color: new Color(unit(numbers[0]!, rMax), unit(numbers[1]!, gMax), unit(numbers[2]!, bMax), args.length === 4 ? unit(numbers[3]!, aMax) : 1),
		form: 'rgb', hasAlphaArgument: args.length === 4, prefix: '', lowercase: false, ranges
	};
}

/**
 * Ways to write the picked color, which the picker's header cycles through.
 *
 * The picker remembers the chosen way by its index, and picks the one matching
 * the written text when it opens, so the order has to stay the same: a gray
 * comes last, so when the color stops being gray the picker falls back to RGB.
 */
function presentations(found: FoundColor, color: Color): string[] {
	const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
	const hex = (...values: number[]) => {
		const digits = values.map((v) => byte(v).toString(16).padStart(2, '0')).join('');
		return found.lowercase ? digits : digits.toUpperCase();
	};
	const [rMax, gMax, bMax, aMax] = found.ranges ?? [255, 255, 255, 255];
	// Whole numbers for ranges like 255, decimals for ranges like 1.0
	const value = (v: number, max: number) => String(Number((Math.min(1, Math.max(0, v)) * max).toFixed(max >= 100 ? 0 : 2)));

	const isOpaque = byte(color.alpha) === 255;
	const isGray = byte(color.red) === byte(color.green) && byte(color.green) === byte(color.blue);
	const prefix = found.form === 'hex' ? found.prefix : '0x';
	const argb = `${prefix}${hex(found.canHaveAlpha ? color.alpha : 1, color.red, color.green, color.blue)}`;
	const web = `#${hex(color.red, color.green, color.blue)}`;

	if (!found.isArguments) {
		// A value on its own can't take an alpha argument, `0xAARRGGBB` has one
		return [isOpaque ? web : argb];
	}
	if (!found.ranges) {
		// Numbers and alpha arguments can't be read in the sketch's color mode
		return [isOpaque ? web : argb, argb];
	}

	// An alpha argument stays once written, and is added for a transparent color
	const alpha = found.canHaveAlpha && (found.hasAlphaArgument || !isOpaque) ? `, ${value(color.alpha, aMax)}` : '';
	const rgb = `${value(color.red, rMax)}, ${value(color.green, gMax)}, ${value(color.blue, bMax)}${alpha}`;
	const result = [
		rgb,
		`${web}${alpha}`,
		// `0xAARRGGBB` holds the alpha itself, unless it was written with an alpha argument
		found.form === 'hex' && found.hasAlphaArgument ? `${prefix}${hex(1, color.red, color.green, color.blue)}${alpha}` : argb
	];
	if (isGray) {
		result.push(`${value(color.red, rMax)}${alpha}`);
	}
	return result;
}
