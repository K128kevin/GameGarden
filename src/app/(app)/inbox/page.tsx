import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { socialAccounts } from "@/db/schema";
import { checkInboxNow } from "@/app/actions";
import { getUserSettings, requireUser } from "@/lib/session";
import { formatDateTime, formatRelative, msFromNow, toLocalInput } from "@/lib/time";
import { replyModelLabel } from "@/lib/reply-models";
import { getConnector } from "@/platforms/registry";
import { INBOUND_CHECK_MINUTES } from "@/services/accounts";
import { INBOX_WINDOW_DAYS, listInbox } from "@/services/inbox";
import { canFollow, canLike, followLabel } from "@/services/social-actions";
import { ActionButton } from "@/components/forms";
import { InboxItem } from "@/components/inbox-item";
import { EmptyState, Link, PageHeader } from "@/components/ui";

export const maxDuration = 60;

export default async function InboxPage() {
  const user = await requireUser();
  const { timezone: tz } = await getUserSettings(user.id);
  const entries = await listInbox(user.id);
  const [acctInfo] = await db
    .select({ n: sql<number>`count(*)::int`, oldest: sql<Date | null>`min(${socialAccounts.inboundCheckedAt})` })
    .from(socialAccounts)
    .where(eq(socialAccounts.userId, user.id));
  const lastChecked = acctInfo?.oldest ? new Date(acctInfo.oldest) : null;
  const newCutoff = msFromNow(-6 * 3_600_000);
  const defaultWhen = toLocalInput(new Date(Math.ceil(msFromNow(30 * 60_000).getTime() / 900_000) * 900_000), tz);

  return (
    <>
      <PageHeader
        title="Inbox"
        subtitle={
          <>
            Replies, mentions and comments waiting on you from the last {INBOX_WINDOW_DAYS} days. Checked about every{" "}
            {INBOUND_CHECK_MINUTES} minutes between plan runs{lastChecked ? ` (all accounts checked ${formatRelative(lastChecked)})` : ""}.
          </>
        }
        actions={
          <ActionButton action={checkInboxNow} pendingText="Checking…">
            Check now
          </ActionButton>
        }
      />
      {acctInfo?.n === 0 ? (
        <EmptyState title="No accounts connected">
          <Link href="/accounts" className="underline">
            Connect an account
          </Link>{" "}
          to see replies here.
        </EmptyState>
      ) : entries.length === 0 ? (
        <EmptyState title="You're all caught up">New replies and mentions will show up here.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {entries.map((e) => {
            const c = getConnector(e.account.platform);
            return (
              <InboxItem
                key={e.interaction.id}
                item={{
                  id: e.interaction.id,
                  kind: e.interaction.kind,
                  author: e.interaction.authorHandle,
                  text: e.interaction.text,
                  url: e.interaction.url,
                  whenLabel: `${formatRelative(e.interaction.occurredAt)} · ${formatDateTime(e.interaction.occurredAt, tz)}`,
                  isNew: e.interaction.occurredAt > newCutoff,
                  account: {
                    platformName: c.name,
                    badgeClass: c.badgeClass,
                    handle: e.account.handle,
                    maxLength: c.capabilities.maxLength,
                  },
                  onPost: e.onPost ? { text: e.onPost.text, title: e.onPost.title } : null,
                  savedDraft: e.interaction.draftText,
                  savedDraftModel: e.interaction.draftModel ? replyModelLabel(e.interaction.draftModel) : null,
                  planDraft: e.planRec?.draftText ?? null,
                  defaultWhen,
                  likeable: canLike(e.account.platform, { externalId: e.interaction.externalId, data: e.interaction.replyTarget }),
                  followable: canFollow(e.account.platform, {
                    externalId: e.interaction.externalId,
                    author: e.interaction.authorHandle,
                    authorId: e.interaction.authorId,
                  }),
                  followLabel: followLabel(e.account.platform),
                }}
              />
            );
          })}
        </ul>
      )}
    </>
  );
}
