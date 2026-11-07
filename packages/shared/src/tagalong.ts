/**
 * Tagalong (BUILD_SPEC §6): the social layer's request schemas and response
 * shapes. Pure: no I/O, no clock, no randomness.
 *
 * Privacy rule: a Tagalong user is only ever shown by the name they chose at
 * opt-in and a city-level label they confirmed. Nothing finer (coordinates,
 * street, postal code) is accepted here, so it can never be stored or shown.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums. These match the CHECK constraints in migrations/0006_tagalong.sql.
// ---------------------------------------------------------------------------

/** Every reportable thing. 'post' is reserved for later ride/rental posts. */
export const REPORT_TARGET_TYPES = ["message", "user", "post"] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

/** What a user may report today ('post' is not accepted until posts exist). */
export const REPORTABLE_TARGET_TYPES = ["message", "user"] as const;
export type ReportableTargetType = (typeof REPORTABLE_TARGET_TYPES)[number];

export const REPORT_REASONS = ["spam", "harassment", "safety", "inappropriate", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_RESOLUTIONS = ["dismissed", "message_removed", "user_suspended"] as const;
export type ReportResolution = (typeof REPORT_RESOLUTIONS)[number];

export const MOD_ACTIONS = ["dismiss", "remove_message", "suspend_user"] as const;
export type ModAction = (typeof MOD_ACTIONS)[number];

export const CONNECTION_STATUSES = ["pending", "accepted", "declined", "closed"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const ROOM_KINDS = ["group", "dm"] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

export const MESSAGE_DELETED_BY = ["author", "moderator"] as const;
export type MessageDeletedBy = (typeof MESSAGE_DELETED_BY)[number];

// ---------------------------------------------------------------------------
// Limits (lengths match the migration's CHECKs).
// ---------------------------------------------------------------------------

export const TAGALONG_NAME_MAX = 40;
export const TAGALONG_CITY_MAX = 80;
export const INTEREST_MAX = 140;
export const MESSAGE_BODY_MAX = 1000;
export const REPORT_DETAILS_MAX = 1000;

// ---------------------------------------------------------------------------
// Text checks.
// ---------------------------------------------------------------------------

/**
 * Common generic TLDs. Any two-letter (country-code) TLD also counts. Kept to
 * a list so "ok.then" or "end.Next" typos are not treated as links.
 */
const GENERIC_TLDS = [
	"com",
	"net",
	"org",
	"edu",
	"gov",
	"int",
	"mil",
	"info",
	"biz",
	"app",
	"dev",
	"xyz",
	"online",
	"site",
	"website",
	"shop",
	"store",
	"club",
	"live",
	"top",
	"link",
	"click",
	"page",
	"blog",
	"tech",
	"cloud",
	"email",
	"chat",
	"social",
	"vip",
	"pro",
	"mobi",
	"name",
	"tickets",
	"events",
	"fun",
	"lol",
	"buzz",
	"icu",
	"cam",
	"bet",
	"win",
	"money",
	"loan",
	"work",
	"today",
	"life",
	"world",
	"news",
	"space",
	"agency",
	"company",
	"solutions",
	"zip",
	"mov",
] as const;

const SCHEME_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S/i;
const WWW_RE = /\bwww\d{0,3}\./i;
const BARE_DOMAIN_RE = new RegExp(
	String.raw`(?:^|[^a-z0-9@-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:${GENERIC_TLDS.join("|")}|[a-z]{2})(?![a-z0-9-])`,
	"i",
);
/** An e-mail address is a way to take someone off-platform too. */
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i;

/**
 * True when `text` looks like it contains a link: a scheme (`http://`,
 * `https://`, any `x://`), a `www.` prefix, a bare `domain.tld` (generic TLDs
 * from a list, or any two-letter country code), or an e-mail address. Used to
 * stop new accounts posting links. Errs towards "yes": a false positive only
 * asks the sender to rephrase.
 */
export function containsUrl(text: string): boolean {
	return (
		SCHEME_RE.test(text) || WWW_RE.test(text) || BARE_DOMAIN_RE.test(text) || EMAIL_RE.test(text)
	);
}

/** Control, zero-width and bidi-override characters: never allowed in a name or interest. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

/**
 * A city label is letters (any script), spaces and `. , ' ’ - ( )`; it must
 * start with a letter. No digits at all, so coordinates ("43.65, -79.38"),
 * street addresses ("12 Main St") and postal codes ("M5V 2T6") are refused:
 * only a city may ever be shown for a Tagalong user.
 */
const CITY_RE = /^\p{L}[\p{L}\p{M} .,'’()-]*$/u;

/** True when `city` is an acceptable city-level label (already trimmed). */
export function isCityLabel(city: string): boolean {
	return (
		city.length >= 1 && city.length <= TAGALONG_CITY_MAX && CITY_RE.test(city) && !containsUrl(city)
	);
}

// ---------------------------------------------------------------------------
// Request schemas.
// ---------------------------------------------------------------------------

export const TagalongNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(TAGALONG_NAME_MAX)
	.refine((s) => !CONTROL_RE.test(s), "No control characters")
	.refine((s) => !containsUrl(s), "No links or e-mail addresses in a name");

export const TagalongCitySchema = z
	.string()
	.trim()
	.min(1)
	.max(TAGALONG_CITY_MAX)
	.refine(isCityLabel, "A city name only: no numbers, coordinates or addresses");

/** POST /tagalong/opt-in */
export const TagalongOptInSchema = z.object({
	confirm: z.literal(true),
	name: TagalongNameSchema,
	city: TagalongCitySchema,
});
export type TagalongOptIn = z.infer<typeof TagalongOptInSchema>;

/**
 * What a member is interested in ("looking for pre-game food"). Trimmed;
 * an empty string becomes null. Optional and nullable.
 */
export const InterestSchema = z
	.string()
	.trim()
	.max(INTEREST_MAX)
	.refine((s) => !CONTROL_RE.test(s), "No control characters")
	.transform((s) => (s === "" ? null : s))
	.nullable()
	.optional();
export type Interest = z.infer<typeof InterestSchema>;

/** A chat message body (group or DM). */
export const MessageBodySchema = z.string().trim().min(1).max(MESSAGE_BODY_MAX);

/** POST /groups/:id/messages and POST /dms/:connectionId/messages */
export const SendMessageSchema = z.object({ body: MessageBodySchema });
export type SendMessage = z.infer<typeof SendMessageSchema>;

const id = z.string().trim().min(1).max(64);

/** POST /events/:eventId/group/join */
export const JoinGroupSchema = z.object({ interest: InterestSchema });
export type JoinGroup = z.infer<typeof JoinGroupSchema>;

/** POST /groups/:id/interest */
export const SetInterestSchema = z.object({ interest: InterestSchema });
export type SetInterest = z.infer<typeof SetInterestSchema>;

/** POST /connections */
export const ConnectRequestSchema = z.object({ user_id: id });
export type ConnectRequest = z.infer<typeof ConnectRequestSchema>;

/** POST /blocks */
export const BlockRequestSchema = z.object({ user_id: id });
export type BlockRequest = z.infer<typeof BlockRequestSchema>;

/** POST /reports. Only 'message' and 'user' are accepted; 'post' is a 400. */
export const ReportInputSchema = z.object({
	target_type: z.enum(REPORTABLE_TARGET_TYPES),
	target_id: id,
	reason: z.enum(REPORT_REASONS),
	details: z
		.string()
		.trim()
		.max(REPORT_DETAILS_MAX)
		.transform((s) => (s === "" ? null : s))
		.nullable()
		.optional(),
});
export type ReportInput = z.infer<typeof ReportInputSchema>;

/** POST /mod/reports/:id/resolve */
export const ModResolveSchema = z.object({ action: z.enum(MOD_ACTIONS) });
export type ModResolve = z.infer<typeof ModResolveSchema>;

// ---------------------------------------------------------------------------
// Response shapes. Never email, home_lat/lng or home_city: only the chosen
// name and the confirmed city label.
// ---------------------------------------------------------------------------

/** The `tagalong` block on GET /me. */
export interface TagalongStatus {
	opted_in: boolean;
	name: string | null;
	city: string | null;
	safety_acked: boolean;
	trusted: boolean;
	suspended: boolean;
}

/** GET /events/:eventId/group */
export interface GroupSummary {
	group_id: string | null;
	member_count: number;
	joined: boolean;
}

export interface GroupMember {
	user_id: string;
	name: string;
	city: string;
	interest: string | null;
	is_me: boolean;
}

/** GET /groups/:id */
export interface GroupDetail {
	group_id: string;
	event: {
		id: string;
		name: string;
		/** ISO 8601 when known. */
		starts_at: string | null;
		/** YYYY-MM-DD in the venue's zone, when known. */
		local_date: string | null;
		city: string | null;
	};
	members: GroupMember[];
}

export interface ChatMessage {
	id: string;
	room_kind: RoomKind;
	/** The group id or the connection id. */
	room_id: string;
	user_id: string;
	name: string;
	body: string;
	created_at: string;
	is_me: boolean;
}

/** Fan-out over the chat socket. */
export type ChatEvent = { type: "message"; message: ChatMessage } | { type: "deleted"; id: string };

export interface Connection {
	id: string;
	other_user_id: string;
	other_name: string;
	other_city: string;
	status: ConnectionStatus;
	requested_by_me: boolean;
	created_at: string;
	responded_at: string | null;
}

/** A group both users are in, as shown on a profile. */
export interface SharedGroup {
	group_id: string;
	event_name: string;
	starts_at: string | null;
}

/** GET /tagalong/users/:id */
export interface TagalongProfile {
	user_id: string;
	name: string;
	city: string;
	is_me: boolean;
	shared_groups: SharedGroup[];
	connection_id: string | null;
	connection_status: ConnectionStatus | null;
	requested_by_me: boolean | null;
}

/** GET /mod/reports: one report with the context a moderator needs. */
export interface ModReport {
	id: string;
	target_type: ReportTargetType;
	target_id: string;
	reason: ReportReason;
	details: string | null;
	created_at: string;
	resolved_at: string | null;
	resolved_by: string | null;
	resolution: ReportResolution | null;
	reporter: { user_id: string; name: string | null };
	/** Set when target_type is 'message'; includes a soft-deleted body. */
	message: {
		id: string;
		body: string;
		room_kind: RoomKind;
		room_id: string;
		author_id: string;
		author_name: string | null;
		created_at: string;
		deleted_at: string | null;
		deleted_by: MessageDeletedBy | null;
	} | null;
	/** The reported user, or the message's author. */
	target_user: {
		user_id: string;
		name: string | null;
		city: string | null;
		suspended: boolean;
	} | null;
}

/** GET /blocks */
export interface BlockedUser {
	user_id: string;
	name: string | null;
	blocked_at: string;
}
