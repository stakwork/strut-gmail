/**
 * Where the Gmail app sends a person: the box's connect seam. A plain
 * function, so the package's test reads it as the page does.
 */

/** The box's connect seam for Google, stadeum's route (its plans/software.md §2.1). */
const SEAM = "/api/connect/google";

/** What the package asks Google for: reading mail and the person's address,
 *  and drafting and sending. Google has no scope for drafts alone. */
export const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"];

/**
 * The box's connect seam, on the host's own page's origin, asking for the
 * package's scopes and coming back to that page:
 * `https://<box>/api/connect/google?scope=<scopes>&return=<page>`. Or none,
 * when that page cannot be shown to be the box's.
 *
 * The rule is stadeum/github's (its apps/github/src/links.ts and README,
 * "Where Connect leads"). `page` is what strut hands an app as `strut/page`,
 * which any page that frames strut can name. `strut` is the address strut's
 * own page was loaded from (`document.baseURI`), which no link can set. A
 * box serves strut at `strut.<box>` and Stadeum, with its seam, at `<box>`,
 * so the seam is offered only when the page is on that `<box>`. Ports may
 * differ, as on a developer's machine.
 */
export function seamLink(page: string | undefined, strut: string | undefined): string | undefined {
  const at = parse(page);
  const self = parse(strut);
  if (!at || !self) return undefined;
  if (!self.hostname.startsWith("strut.")) return undefined;
  const box = self.hostname.slice("strut.".length);
  if (!box.includes(".") || at.hostname !== box || at.protocol !== self.protocol) return undefined;
  const seam = new URL(SEAM, at.origin);
  seam.searchParams.set("scope", SCOPES.join(" "));
  seam.searchParams.set("return", at.href);
  return seam.href;
}

/**
 * Gmail's own page for the person's drafts, or for one thread, in the
 * account the app is connected to (`authuser`, when the address is known;
 * else Gmail's first signed-in account). None for a thread id that is not
 * one.
 */
export function gmailLink(address: string | undefined, where: "drafts" | { thread: string }): string | undefined {
  if (where !== "drafts" && !/^[A-Za-z0-9_-]{1,128}$/.test(where.thread)) return undefined;
  const url = new URL("https://mail.google.com/mail/");
  if (address) url.searchParams.set("authuser", address);
  url.hash = where === "drafts" ? "drafts" : `all/${where.thread}`;
  return url.href;
}

/** The address a person writes to for Email Jamie: their own, with +jamie (their own +tag taken off first). */
export function jamieAddress(address: string | undefined): string | undefined {
  const at = address?.lastIndexOf("@") ?? -1;
  if (!address || at < 1) return undefined;
  const local = address.slice(0, at).replace(/\+.*$/, "");
  return local ? `${local}+jamie@${address.slice(at + 1)}` : undefined;
}

const parse = (raw: string | undefined): URL | undefined => {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
};
