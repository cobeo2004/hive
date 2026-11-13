"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { pollGithubLink, startGithubLink, unlinkGithub } from "@/app/actions/github-link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type Code = { userCode: string; verificationUri: string; interval: number; handle: string };
const FAILED = {
  expired: "The code expired. Try again.",
  denied: "You cancelled on GitHub.",
  taken: "That GitHub account is linked to another Hive user.",
  failed: "Linking failed. Try again.",
};

export function GithubLinkCard({ login }: { login: string | null }) {
  const router = useRouter();
  const [code, setCode] = useState<Code | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Polls on GitHub's interval until the code is used, refused or expired; the server holds the device code.
  useEffect(() => {
    if (!code) return;
    let wait = code.interval;
    let timer: ReturnType<typeof setTimeout>;
    let live = true;
    const tick = async () => {
      const polled = await pollGithubLink(code.handle).catch(() => ({ status: "failed" as const }));
      if (!live) return;
      if (polled.status === "pending") {
        wait = Math.max(polled.slowDown ? wait + 5 : wait, polled.interval);
        timer = setTimeout(tick, wait * 1000);
        return;
      }
      setCode(null);
      if (polled.status === "linked") router.refresh();
      else setFailure(FAILED[polled.status]);
    };
    timer = setTimeout(tick, wait * 1000);
    return () => void ((live = false), clearTimeout(timer));
  }, [code, router]);

  const start = () =>
    startTransition(async () => {
      setFailure(null);
      const started = await startGithubLink();
      if (started.ok) setCode(started);
      else setFailure(started.message);
    });
  const remove = () => startTransition(async () => (await unlinkGithub(), router.refresh()));

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        {login ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex-1 text-sm">{`Linked as @${login}`}</span>
            <Button size="sm" variant="ghost" loading={pending} onClick={remove}>
              Unlink
            </Button>
          </div>
        ) : code ? (
          <div className="flex flex-col gap-2 text-sm">
            <p className="font-mono text-2xl tracking-widest">{code.userCode}</p>
            <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
              Enter it at
              <a href={code.verificationUri} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                {code.verificationUri}
              </a>
              · waiting for GitHub…
              <Button size="sm" variant="ghost" onClick={() => setCode(null)}>
                Cancel
              </Button>
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex-1 text-sm text-muted-foreground">Not linked.</span>
            <Button size="sm" loading={pending} onClick={start}>
              Link GitHub
            </Button>
          </div>
        )}
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
