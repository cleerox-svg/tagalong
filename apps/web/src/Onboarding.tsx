import { useState } from "react";
import { api, type Me } from "./api.js";

export const COMMON_CURRENCIES = [
	"CAD",
	"USD",
	"EUR",
	"GBP",
	"AUD",
	"NZD",
	"MXN",
	"JPY",
	"CHF",
	"SEK",
	"NOK",
	"DKK",
	"BRL",
	"INR",
	"ZAR",
];

export function Onboarding({ me, onDone }: { me: Me; onDone: () => void }) {
	const [adult, setAdult] = useState(false);
	const [currency, setCurrency] = useState(me.home_currency ?? "CAD");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	return (
		<section className="card narrow">
			<h1>Welcome, {me.display_name}</h1>
			<form
				onSubmit={async (e) => {
					e.preventDefault();
					if (!adult) return setError("You need to be 18 or older to use Budgetrip.");
					setBusy(true);
					setError(null);
					try {
						await api.onboard({ confirm_18_or_older: true, home_currency: currency });
						onDone();
					} catch {
						setError("That didn't save. Try again.");
					} finally {
						setBusy(false);
					}
				}}
			>
				<label className="check">
					<input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} />I
					confirm I am 18 or older.
				</label>
				<label>
					Currency for budgets
					<select value={currency} onChange={(e) => setCurrency(e.target.value)}>
						{COMMON_CURRENCIES.map((c) => (
							<option key={c}>{c}</option>
						))}
					</select>
				</label>
				{error && <p className="error">{error}</p>}
				<button className="primary" disabled={busy}>
					Continue
				</button>
			</form>
		</section>
	);
}
