import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { appLink, useHost, useShareLink, useStrutClient } from "@strut/kit";
import { ExternalLink, Mail, Plug } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { gmailLink, seamLink } from "./links";

// The package's steps, by their full names.
const ME = "stadeum/gmail/me";
const DISCONNECT = "stadeum/gmail/disconnect";
const SETTINGS = "stadeum/gmail/settings";
const SAVE = "stadeum/gmail/save";
const WAITING = "stadeum/gmail/waiting";
/** Strut's Knowledge app, where the shared instructions page opens. */
const KNOWLEDGE = "strut/knowledge";
/** How long typing pauses before the instructions are saved. */
const SAVE_AFTER_MS = 700;

interface Me {
  connected: boolean;
  address?: string;
  refused?: boolean;
}
interface Disconnected {
  removed: boolean;
  revoked?: boolean;
  why?: string;
  manage?: string;
}
interface Settings {
  replies: boolean;
  search: string;
  instructions: string;
}
interface Waiting {
  drafts: number;
  needsYou: Array<{ thread: string; message: string; from?: { address: string; name?: string }; subject: string; reason: string; at: string }>;
  page?: string;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^(step_run: |Error: )+/, "");

export default function App() {
  const client = useStrutClient();
  const qc = useQueryClient();
  const host = useHost();
  // The host's own page for this app (on a box, Stadeum's, where the
  // connect seam is), offered only when it is on the box this strut is
  // served for (./links.ts).
  const page = useShareLink()?.();
  const strut = typeof document !== "undefined" ? document.baseURI : undefined;
  const connect = seamLink(page, strut);
  const me = useQuery({ queryKey: ["gmail", "me"], queryFn: () => client.run<Me>(ME) });
  const [notice, setNotice] = useState<{ text: string; link?: { href: string; label: string } }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  // A connect runs in a tab of its own: read it all again when the person comes back.
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === "visible") void qc.invalidateQueries({ queryKey: ["gmail"] });
    };
    document.addEventListener("visibilitychange", again);
    window.addEventListener("focus", again);
    return () => {
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("focus", again);
    };
  }, [qc]);

  const disconnect = async () => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const out = await client.run<Disconnected>(DISCONNECT);
      if (!out.removed) setNotice({ text: "Not connected." });
      else if (out.revoked) setNotice({ text: "Disconnected." });
      else
        setNotice({
          text: "Disconnected here, but Google didn't confirm. Remove the access in your Google account.",
          ...(out.manage ? { link: { href: out.manage, label: "Your Google connections" } } : {}),
        });
    } catch (e) {
      setError(message(e));
    } finally {
      await qc.invalidateQueries({ queryKey: ["gmail"] });
      setBusy(false);
    }
  };

  const data = me.data;
  const connected = !!data?.connected && !data.refused;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex items-center gap-2">
        <Mail className="size-5 text-brand" />
        <h1 className="text-lg font-semibold">Gmail</h1>
      </header>

      {error && (
        <Alert variant="destructive">
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert>
          <AlertDescription className="flex flex-col gap-2">
            <span>{notice.text}</span>
            {notice.link && (
              <Button variant="link" className="h-auto self-start p-0" onClick={() => void host.openLink(notice.link!.href)}>
                {notice.link.label}
                <ExternalLink className="size-3" />
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-base">Your account</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-4">
          {me.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {me.error && (
            <Alert variant="destructive">
              <AlertDescription className="break-words">{message(me.error)}</AlertDescription>
            </Alert>
          )}
          {data && !data.connected && (
            <>
              <p className="text-sm">Not connected.</p>
              {connect ? (
                <div>
                  <Button onClick={() => void host.openLink(connect)} disabled={busy}>
                    <Plug className="size-4" />
                    Connect Google
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Open Gmail in Stadeum to connect.</p>
              )}
            </>
          )}
          {data?.connected && (
            <>
              {data.refused ? (
                <p className="text-sm text-destructive">Google no longer accepts this connection. Disconnect, then connect again.</p>
              ) : (
                <p className="text-sm">
                  Connected as <span className="font-semibold">{data.address}</span>
                </p>
              )}
              <div>
                <Button variant="outline" onClick={() => setDisconnecting(true)} disabled={busy}>
                  Disconnect
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {connected && <Replies address={data?.address} />}

      {disconnecting && data?.connected && (
        <AlertDialog open onOpenChange={(open) => !open && setDisconnecting(false)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Disconnect Google?</AlertDialogTitle>
              <AlertDialogDescription>Your workflows can no longer read or send your mail. Anything else here that uses your Google account stops too.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setDisconnecting(false);
                  void disconnect();
                }}
              >
                Disconnect
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

/** Replies: on or off, the drafts waiting, the person's own instructions, the mail it answers, and what needs them. */
function Replies({ address }: { address?: string }) {
  const client = useStrutClient();
  const qc = useQueryClient();
  const host = useHost();
  const settings = useQuery({ queryKey: ["gmail", "settings"], queryFn: () => client.run<Settings>(SETTINGS) });
  const on = settings.data?.replies === true;
  const waiting = useQuery({ queryKey: ["gmail", "waiting"], queryFn: () => client.run<Waiting>(WAITING), enabled: on });
  const [error, setError] = useState<string>();

  const save = async (patch: Partial<Settings>) => {
    setError(undefined);
    try {
      const out = await client.run<Settings>(SAVE, patch);
      qc.setQueryData(["gmail", "settings"], out);
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    }
  };

  const open = (href: string | undefined) => href && void host.openLink(href);
  const drafts = waiting.data?.drafts ?? 0;
  const s = settings.data;

  return (
    <>
      <Card className="gap-3 py-4">
        <CardHeader className="flex flex-row items-start justify-between gap-3 px-4">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-base">
              <Label htmlFor="replies">Replies</Label>
            </CardTitle>
            <p className="text-sm text-muted-foreground">Jamie answers your mail</p>
          </div>
          {s && <Switch id="replies" checked={on} onCheckedChange={(checked) => void save({ replies: checked })} />}
        </CardHeader>
        {error && (
          <CardContent className="px-4">
            <Alert variant="destructive">
              <AlertDescription className="break-words">{error}</AlertDescription>
            </Alert>
          </CardContent>
        )}
        {settings.error && (
          <CardContent className="px-4">
            <p className="text-sm text-destructive">{message(settings.error)}</p>
          </CardContent>
        )}
        {s && on && (
          <CardContent className="flex flex-col gap-5 px-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>{waiting.isLoading ? "Counting drafts…" : `${drafts} ${drafts === 1 ? "draft" : "drafts"} waiting`}</span>
              <Button variant="link" className="h-auto p-0" onClick={() => open(gmailLink(address, "drafts"))}>
                Open Gmail
                <ExternalLink className="size-3" />
              </Button>
            </div>

            <Instructions
              initial={s.instructions}
              onSave={(instructions) => save({ instructions })}
              shared={waiting.data?.page ? () => open(appLink(KNOWLEDGE, { concept: waiting.data!.page })) : undefined}
            />

            <Search initial={s.search} onSave={(search) => save({ search })} />
          </CardContent>
        )}
      </Card>

      {s && on && (
        <Card className="gap-3 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-base">Needs you</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col divide-y px-4">
            {waiting.isLoading && <p className="py-2 text-sm text-muted-foreground">Loading…</p>}
            {waiting.error && <p className="py-2 text-sm text-destructive">{message(waiting.error)}</p>}
            {waiting.data && !waiting.data.needsYou.length && <p className="py-2 text-sm text-muted-foreground">Nothing right now.</p>}
            {waiting.data?.needsYou.map((n) => (
              <button
                key={n.thread}
                type="button"
                className="flex min-w-0 flex-col gap-0.5 py-2 text-left hover:bg-muted/50"
                onClick={() => open(gmailLink(address, { thread: n.thread }))}
              >
                <span className="flex min-w-0 items-baseline gap-2 text-sm">
                  <span className="shrink-0 font-medium">{n.from?.name ?? n.from?.address ?? "Unknown sender"}</span>
                  <span className="truncate">{n.subject || "(no subject)"}</span>
                </span>
                <span className="text-xs text-muted-foreground">{n.reason}</span>
              </button>
            ))}
          </CardContent>
        </Card>
      )}
    </>
  );
}

/** Your instructions: saved as the person types, with "Saved" once it is. */
function Instructions({ initial, onSave, shared }: { initial: string; onSave: (text: string) => Promise<boolean>; shared?: () => void }) {
  const [text, setText] = useState(initial);
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const change = (next: string) => {
    setText(next);
    setSaved(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void onSave(next).then((ok) => setSaved(ok)), SAVE_AFTER_MS);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Label htmlFor="instructions">Your instructions</Label>
        {shared && (
          <Button variant="link" className="h-auto p-0 text-xs" onClick={shared}>
            Shared instructions
          </Button>
        )}
        {saved && <span className="text-xs text-muted-foreground">Saved</span>}
      </div>
      <Textarea id="instructions" rows={4} value={text} onChange={(e) => change(e.target.value)} placeholder="Keep replies short. Sign off with my first name." />
    </div>
  );
}

/** Mail to answer: a Gmail search, saved when the person leaves the field or presses Enter. */
function Search({ initial, onSave }: { initial: string; onSave: (search: string) => Promise<boolean> }) {
  const [text, setText] = useState(initial);
  const [saved, setSaved] = useState(false);
  const commit = async () => {
    if (text.trim() === initial.trim()) return;
    const ok = await onSave(text);
    setSaved(ok);
  };
  useEffect(() => setText(initial), [initial]);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Label htmlFor="search">Mail to answer</Label>
        {saved && <span className="text-xs text-muted-foreground">Saved</span>}
      </div>
      <Input
        id="search"
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
        onBlur={() => void commit()}
        onKeyDown={(e) => e.key === "Enter" && void commit()}
      />
    </div>
  );
}
