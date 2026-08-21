import type { NextRequest } from 'next/server';

/**
 * Which edition of Kannan's profile a visitor sees.
 *
 * The portfolio has shipped two editions for a while: a Dubai one by default,
 * and an India one when the visitor is geolocated in India or arrives via
 * `/ind`. A recruiter in Chennai being told about UAE visa sponsorship reads as
 * a template that was never adapted, so DocMind mirrors the same split.
 *
 * This is entirely separate from the origin trust in `privacy.ts`, and the two
 * must not be collapsed into one flag even though both are "who is asking":
 *
 *   trust  → *may* this visitor see the preloaded profile and contact details?
 *   region → *which* availability story is the honest one for them?
 *
 * An Indian recruiter arriving through the portfolio iframe is trusted (gets the
 * phone number) and Indian (gets the Chennai framing). Both checks run, and
 * neither implies the other.
 *
 * Unlike trust, region is editorial rather than protective. There is nothing to
 * gain by forging it — both editions are public on the portfolio — so a
 * spoofable header is the right cost here, and no signed token is warranted.
 */
export type Region = 'dubai' | 'india';

/**
 * Dubai is the default, matching the portfolio.
 *
 * It is also the safe default for the two cases where no signal exists: local
 * development, and any host that is not Vercel. Same reasoning as
 * `trustedOrigins()` returning nothing when its variable is unset — when the
 * signal is missing, fall back to the documented behaviour rather than guess.
 */
export const DEFAULT_REGION: Region = 'dubai';

function parseRegion(value: string | null | undefined): Region | null {
  switch (value?.trim().toLowerCase()) {
    case 'in':
    case 'ind':
    case 'india':
      return 'india';
    case 'ae':
    case 'uae':
    case 'dubai':
      return 'dubai';
    default:
      return null;
  }
}

/**
 * Region for this request.
 *
 * Two inputs, override first:
 *
 *   1. `x-region-override`, set by the client from its own `?region=` query
 *      string. Without it there is no way to exercise the India path at all —
 *      `x-vercel-ip-country` does not exist on a dev server, and nobody can
 *      change which country they are in to test a deploy. It also gives the
 *      portfolio a way to forward its own `/ind` choice into the iframe.
 *   2. `x-vercel-ip-country`, which Vercel attaches at the edge on real
 *      deployments. `IN` is the only value that changes anything today.
 */
export function resolveRegion(req: NextRequest): Region {
  const override = parseRegion(req.headers.get('x-region-override'));
  if (override) return override;

  return req.headers.get('x-vercel-ip-country')?.trim().toUpperCase() === 'IN'
    ? 'india'
    : DEFAULT_REGION;
}

/**
 * Preloaded documents that belong to one edition only.
 *
 * Keyed by filename rather than by heading or by matching "Dubai" in the text,
 * for two reasons. Headings are prose and get reworded; a filter silently
 * matching nothing is worse than no filter. And matching on content would catch
 * a recruiter's *own* uploaded job description for a Dubai role and quietly drop
 * it — the same failure as the reserved-slot bug, where the agent insisted a
 * document it had indexed did not exist.
 *
 * Filenames here must match `docs/seed/` exactly; `scripts/verify.mjs` asserts
 * that they do, so a rename fails the preflight instead of the demo.
 */
export const REGION_DOCUMENTS: Record<Region, string> = {
  dubai: 'Kannan Santharam — Dubai Relocation and Availability.md',
  india: 'Kannan Santharam — India Availability.md',
};

/** The preloaded document that does *not* belong to this visitor's edition. */
export function excludedRegionDocument(region: Region): string {
  return REGION_DOCUMENTS[region === 'india' ? 'dubai' : 'india'];
}
