// The shapes of the Oncade replies this project reads. Only the fields we
// use are listed: anything else in a reply is ignored. Marks (seen / docs)
// are in docs/context/oncade-contract.md.

import { z } from 'zod';

export const ErrorReply = z.object({ error: z.string().optional(), code: z.string().optional() });

export const FeePreview = z.object({
  fees: z.array(
    z.object({
      label: z.string(),
      percentage: z.number().default(0),
      /** Cents. */
      flat: z.number().default(0),
      feeType: z.enum(['flat_rate_plus_percentage', 'per_payout_plus_percentage']).default('flat_rate_plus_percentage'),
    }),
  ),
});

export const Invoice = z.object({
  _id: z.string(),
  status: z.string(),
  /** Dollars. */
  total: z.number(),
  links: z.object({ invoice: z.string().optional() }).optional(),
  externalMetadata: z.record(z.string(), z.unknown()).nullish(),
});

export const InvoiceList = z.object({
  invoices: z.array(Invoice),
  pagination: z.object({ totalPages: z.number() }),
});

export const Distribution = z.object({
  _id: z.string(),
  status: z.string(),
  totalAmountCents: z.number(),
  totalFeeCents: z.number().default(0),
  memo: z.string().nullish(),
  lineItems: z.array(z.object({ email: z.string(), amountCents: z.number(), status: z.string() })).default([]),
});

export const DistributionList = z.object({
  distributions: z.array(Distribution),
  pagination: z.object({ totalPages: z.number() }),
});

export const Cancelled = z.object({ status: z.string() });
