import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { contacts, accounts } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { findOrCreateContact, findOrCreateAccount } from "@/lib/contacts";
import {
  enrichContactViaApollo,
  enrichAccountViaApollo,
} from "@/lib/enrichment";

export const maxDuration = 60;

/**
 * Enrichment API route for testing Apollo integration.
 * Accepts a contactId, accountId, or { email, name, company } to enrich.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { contactId, accountId, email, firstName, lastName, company } = body;

  // Enrich an existing contact by ID
  if (contactId) {
    const result = await enrichContactViaApollo({ contactId });
    return NextResponse.json(result);
  }

  // Enrich an existing account by ID
  if (accountId) {
    const [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);

    if (!account) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    const result = await enrichAccountViaApollo({
      accountId,
      domain: account.domain,
      name: account.name,
    });
    return NextResponse.json(result);
  }

  // Enrich by name/email/company — find or create the contact first
  if (email || (firstName && company) || (lastName && company)) {
    const cId = await findOrCreateContact({
      email,
      firstName,
      lastName,
      companyName: company,
      leadSource: "manual",
    });

    const result = await enrichContactViaApollo({
      contactId: cId,
      firstName,
      lastName,
      email,
      companyName: company,
    });
    return NextResponse.json({ contactId: cId, ...result });
  }

  return NextResponse.json(
    { error: "Provide contactId, accountId, or {email, firstName, lastName, company}" },
    { status: 400 }
  );
}
