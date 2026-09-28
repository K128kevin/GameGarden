import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { SignInButton } from "@/components/auth-buttons";
import { Notice } from "@/components/ui";

export const dynamic = "force-dynamic";

const features = [
  ["Connect your accounts", "Bluesky, YouTube and Reddit today — built so more platforms plug in easily."],
  ["Organize by game", "Link posts, accounts, and your Steam & itch.io pages to each game you're making."],
  ["AI growth plans", "Twice a day (9 AM & 9 PM ET) GameGarden reviews what happened and updates a long-term plan."],
  ["Drafts, times, one click", "Every suggested post or reply comes drafted with a recommended time. Schedule it in one click."],
  ["You're always in control", "Nothing is ever posted without your explicit approval."],
];

export default async function Home({ searchParams }: PageProps<"/">) {
  const user = await getSessionUser();
  if (user) redirect("/dashboard");
  const { error } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
      <div className="text-4xl">🌱</div>
      <h1 className="mt-4 text-4xl font-semibold tracking-tight text-zinc-50">GameGarden</h1>
      <p className="mt-3 max-w-xl text-lg text-zinc-400">
        Social media marketing and account growth for indie game developers — with an AI strategist that learns from
        what actually works.
      </p>
      {error && (
        <div className="mt-6 max-w-md">
          <Notice kind="error">Sign-in failed or this account isn&apos;t allowed on this instance.</Notice>
        </div>
      )}
      <div className="mt-8">
        <SignInButton />
      </div>
      <ul className="mt-14 grid gap-4 sm:grid-cols-2">
        {features.map(([t, d]) => (
          <li key={t} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="font-medium text-zinc-100">{t}</div>
            <div className="mt-1 text-sm text-zinc-400">{d}</div>
          </li>
        ))}
      </ul>
    </main>
  );
}
