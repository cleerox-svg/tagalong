/**
 * Money is integer minor units plus an ISO 4217 code (spec §2.3). No floats
 * ever hold an amount; a float appears only as an exchange rate, and every
 * conversion rounds the result back to whole minor units.
 */

export interface Money {
	amount_minor: number;
	currency: string;
}

/** ISO 4217 codes whose minor unit is not 2 decimal places. Everything else is 2. */
const EXPONENTS: Readonly<Record<string, number>> = {
	BIF: 0,
	CLP: 0,
	DJF: 0,
	GNF: 0,
	ISK: 0,
	JPY: 0,
	KMF: 0,
	KRW: 0,
	PYG: 0,
	RWF: 0,
	UGX: 0,
	UYI: 0,
	VND: 0,
	VUV: 0,
	XAF: 0,
	XOF: 0,
	XPF: 0,
	BHD: 3,
	IQD: 3,
	JOD: 3,
	KWD: 3,
	LYD: 3,
	OMR: 3,
	TND: 3,
};

export const CURRENCY_RE = /^[A-Z]{3}$/;

export function isCurrencyCode(code: string): boolean {
	return CURRENCY_RE.test(code);
}

export function currencyExponent(currency: string): number {
	assertCurrency(currency);
	return EXPONENTS[currency] ?? 2;
}

function assertCurrency(currency: string): void {
	if (!isCurrencyCode(currency)) throw new RangeError(`not an ISO 4217 code: ${currency}`);
}

function assertMinor(amount_minor: number): void {
	if (!Number.isSafeInteger(amount_minor)) {
		throw new RangeError(`amount_minor must be a safe integer, got ${amount_minor}`);
	}
}

/**
 * Parses a decimal string in MAJOR units ("1200", "1,200.50") into minor units
 * without going through a float. Extra decimal places beyond the currency's
 * exponent are rejected rather than silently rounded.
 */
export function parseMajor(input: string, currency: string): number {
	const exp = currencyExponent(currency);
	const cleaned = input.trim().replace(/[,\s_]/g, "");
	const m = /^(\d+)(?:\.(\d+))?$/.exec(cleaned);
	if (!m) throw new RangeError(`not a positive decimal amount: ${input}`);
	const whole = m[1] ?? "0";
	const frac = m[2] ?? "";
	if (frac.length > exp) {
		throw new RangeError(`${currency} has ${exp} decimal places; got ${input}`);
	}
	const minor = Number(whole + frac.padEnd(exp, "0"));
	assertMinor(minor);
	return minor;
}

/**
 * Converts using a rate expressed as "1 unit of `from` = rate units of `to`".
 * Rounds UP: the result feeds a budget check, and rounding a cost down is how
 * "under budget" turns into a lie.
 */
export function convertMinor(amount_minor: number, from: string, to: string, rate: number): number {
	assertMinor(amount_minor);
	if (from === to) return amount_minor;
	if (!(rate > 0) || !Number.isFinite(rate))
		throw new RangeError(`bad rate ${from}->${to}: ${rate}`);
	const shift = currencyExponent(to) - currencyExponent(from);
	// toFixed(6) strips binary noise (0.1 * 3 = 0.30000000000000004) before the ceil.
	const raw = Number((amount_minor * rate * 10 ** shift).toFixed(6));
	return Math.ceil(raw);
}

/** Minor units for an amount given in major units of USD-style rate tables. */
export function majorToMinor(major: number, currency: string): number {
	const exp = currencyExponent(currency);
	return Math.ceil(Number((major * 10 ** exp).toFixed(6)));
}

export function formatMoney(m: Money, locale = "en"): string {
	const exp = currencyExponent(m.currency);
	return new Intl.NumberFormat(locale, {
		style: "currency",
		currency: m.currency,
		minimumFractionDigits: exp,
		maximumFractionDigits: exp,
	}).format(m.amount_minor / 10 ** exp);
}

/**
 * Exchange rates keyed by pair. A rate table is built from stored, dated rows
 * (`fx_rates`), never from a constant, so every conversion can say "as of".
 */
export interface FxRate {
	base: string;
	quote: string;
	rate: number;
	as_of: string;
}

export class FxTable {
	private readonly rates = new Map<string, FxRate>();

	constructor(rows: readonly FxRate[]) {
		for (const r of rows) this.rates.set(`${r.base}>${r.quote}`, r);
	}

	/** One-hop rate: direct or inverse. */
	private hop(from: string, to: string): FxRate | null {
		const direct = this.rates.get(`${from}>${to}`);
		if (direct) return direct;
		const inverse = this.rates.get(`${to}>${from}`);
		if (inverse) return { base: from, quote: to, rate: 1 / inverse.rate, as_of: inverse.as_of };
		return null;
	}

	/** Direct rate, its inverse, or a cross through one pivot currency. */
	find(from: string, to: string): FxRate | null {
		if (from === to) return { base: from, quote: to, rate: 1, as_of: "" };
		const one = this.hop(from, to);
		if (one) return one;
		const pivots = new Set<string>();
		for (const r of this.rates.values()) {
			pivots.add(r.base);
			pivots.add(r.quote);
		}
		for (const p of [...pivots].sort()) {
			if (p === from || p === to) continue;
			const a = this.hop(from, p);
			const b = a && this.hop(p, to);
			if (a && b) {
				return {
					base: from,
					quote: to,
					rate: a.rate * b.rate,
					as_of: a.as_of < b.as_of ? a.as_of : b.as_of,
				};
			}
		}
		return null;
	}

	convert(m: Money, to: string): Money {
		const rate = this.find(m.currency, to);
		if (!rate) throw new MissingRateError(m.currency, to);
		return { amount_minor: convertMinor(m.amount_minor, m.currency, to, rate.rate), currency: to };
	}
}

export class MissingRateError extends Error {
	constructor(
		readonly from: string,
		readonly to: string,
	) {
		super(`no exchange rate ${from} -> ${to}`);
		this.name = "MissingRateError";
	}
}
