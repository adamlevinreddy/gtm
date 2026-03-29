import { db } from "./db";
import {
  accounts,
  contacts,
  conferences,
  conferenceLists,
  listContacts,
  companies,
} from "./schema";
import { eq, and } from "drizzle-orm";
import type { Persona } from "./types";

/**
 * Find or create an account by company name.
 * Links to the classification `companies` table if a match exists.
 */
export async function findOrCreateAccount(
  companyName: string
): Promise<string> {
  const existing = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.name, companyName))
    .limit(1);

  if (existing.length > 0) return existing[0].id;

  // Check classification table for a link
  const classMatch = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.name, companyName))
    .limit(1);

  const [row] = await db
    .insert(accounts)
    .values({
      name: companyName,
      classificationCompanyId: classMatch[0]?.id ?? null,
    })
    .returning({ id: accounts.id });

  return row.id;
}

/**
 * Find or create a contact. Upserts by email first, then by title+company composite.
 * Returns the contact ID.
 */
export async function findOrCreateContact(data: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  title?: string | null;
  companyName?: string | null;
  persona?: Persona | null;
  hubspotContactId?: string | null;
  leadSource?: string | null;
  conferenceName?: string | null;
  lifecycleStage?: string | null;
}): Promise<string> {
  // 1. Try to find by email
  if (data.email) {
    const existing = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.email, data.email))
      .limit(1);

    if (existing.length > 0) {
      // Update with any new data we have
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (data.hubspotContactId) updates.hubspotContactId = data.hubspotContactId;
      if (data.persona && data.persona !== "unknown") updates.persona = data.persona;
      if (data.title) updates.title = data.title;
      if (data.firstName) updates.firstName = data.firstName;
      if (data.lastName) updates.lastName = data.lastName;

      await db
        .update(contacts)
        .set(updates)
        .where(eq(contacts.id, existing[0].id));

      return existing[0].id;
    }
  }

  // 2. Try to find by title + company (for conference attendees without email)
  if (data.title && data.companyName) {
    const existing = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.title, data.title),
          eq(contacts.companyName, data.companyName)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (data.hubspotContactId) updates.hubspotContactId = data.hubspotContactId;
      if (data.persona && data.persona !== "unknown") updates.persona = data.persona;
      if (data.email) updates.email = data.email;
      if (data.firstName) updates.firstName = data.firstName;
      if (data.lastName) updates.lastName = data.lastName;

      await db
        .update(contacts)
        .set(updates)
        .where(eq(contacts.id, existing[0].id));

      return existing[0].id;
    }
  }

  // 3. Create new contact
  let accountId: string | null = null;
  if (data.companyName) {
    accountId = await findOrCreateAccount(data.companyName);
  }

  const [row] = await db
    .insert(contacts)
    .values({
      accountId,
      companyName: data.companyName ?? undefined,
      firstName: data.firstName ?? undefined,
      lastName: data.lastName ?? undefined,
      email: data.email ?? undefined,
      title: data.title ?? undefined,
      persona: (data.persona as typeof contacts.$inferInsert.persona) ?? undefined,
      hubspotContactId: data.hubspotContactId ?? undefined,
      leadSource: (data.leadSource as typeof contacts.$inferInsert.leadSource) ?? undefined,
      conferenceName: data.conferenceName ?? undefined,
      lifecycleStage: data.lifecycleStage ?? undefined,
    })
    .returning({ id: contacts.id });

  return row.id;
}

/**
 * Persist all attendees from a review to the contacts + list_contacts tables.
 * Creates a conference_lists row and optionally a conferences row.
 */
export async function persistAttendees(params: {
  reviewId: string;
  source: string;
  fileName?: string;
  attendees: {
    company: string;
    title: string;
    persona: Persona;
    inHubspot: boolean;
    hubspotName?: string;
    hubspotContactId?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
  }[];
}): Promise<{ contactsCreated: number; listId: string }> {
  const { reviewId, source, fileName, attendees } = params;

  // Create a conference_lists row for this upload
  const [list] = await db
    .insert(conferenceLists)
    .values({
      fileName: fileName || source,
      reviewId,
      uploadedBy: "slack",
      totalRows: attendees.length,
      totalCompanies: new Set(attendees.map((a) => a.company)).size,
      processingStatus: "completed",
    })
    .returning({ id: conferenceLists.id });

  let contactsCreated = 0;

  for (const attendee of attendees) {
    const contactId = await findOrCreateContact({
      firstName: attendee.firstName || (attendee.hubspotName?.split(" ")[0] ?? null),
      lastName: attendee.lastName || (attendee.hubspotName?.split(" ").slice(1).join(" ") ?? null),
      email: attendee.email ?? null,
      title: attendee.title,
      companyName: attendee.company,
      persona: attendee.persona,
      hubspotContactId: attendee.hubspotContactId ?? null,
      leadSource: "conference_pre",
      conferenceName: source,
    });

    // Link contact to the list
    await db
      .insert(listContacts)
      .values({
        listId: list.id,
        contactId,
        originalTitle: attendee.title,
        wasInHubspot: attendee.inHubspot,
      })
      .onConflictDoNothing();

    contactsCreated++;
  }

  // Update the list with total contacts
  await db
    .update(conferenceLists)
    .set({ totalContacts: contactsCreated })
    .where(eq(conferenceLists.id, list.id));

  return { contactsCreated, listId: list.id };
}

/** Read all contacts at a given account */
export async function getContactsByAccount(accountId: string) {
  return db
    .select()
    .from(contacts)
    .where(eq(contacts.accountId, accountId));
}

/** Read all contacts from a specific conference list */
export async function getContactsByConferenceList(listId: string) {
  return db
    .select({
      contact: contacts,
      listContact: listContacts,
    })
    .from(listContacts)
    .innerJoin(contacts, eq(listContacts.contactId, contacts.id))
    .where(eq(listContacts.listId, listId));
}
