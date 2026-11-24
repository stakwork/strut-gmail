import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useHost, useShareLink, useStrutClient } from "@strut/kit";
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
import { seamLink } from "./links";

// The package's steps, by their full names.
const ME = "stadeum/gmail/me";
const DISCONNECT = "stadeum/gmail/disconnect";

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
