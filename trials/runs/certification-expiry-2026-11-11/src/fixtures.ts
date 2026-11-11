export const at = (iso: string) => Date.parse(iso);
export const DAY = 86_400_000;
export const NOW = at('2026-11-11T00:00:00Z');
export const EDGE = at('2026-11-21T00:00:00Z');
export const GAP_END = at('2026-11-25T00:00:00Z');
export const START = at('2026-01-01T00:00:00Z');
export const FAR = at('2027-03-01T00:00:00Z');
export interface Certificate { id: string; tech: string; cert: string; from: number; to: number }
const c = (id: string, tech: string, from: number, to: number, cert = 'electrical'): Certificate => ({ id, tech, cert, from, to });
export const certificates: Certificate[] = [
  c('exact', 'exact', START, NOW),
  c('seam-old', 'seam', START, EDGE), c('seam-next', 'seam', EDGE, FAR),
  c('gap-old', 'gap', START, EDGE), c('gap-next', 'gap', GAP_END, FAR),
  c('late-old', 'late', START, EDGE), c('late-next', 'late', GAP_END, FAR),
  c('over-a', 'overlap', START, at('2026-11-30T00:00:00Z')),
  c('over-b', 'overlap', at('2026-11-20T00:00:00Z'), at('2026-12-05T00:00:00Z')),
  c('missing-elec', 'missing', START, FAR),
  c('qualified-elec', 'qualified', START, FAR), c('qualified-chem', 'qualified', START, FAR, 'chemical'),
  c('horizon', 'horizon', START, NOW + 30 * DAY),
  c('outside', 'outside', START, NOW + 30 * DAY + 1),
];
export const assignments = [
  ['exact', 'plant'], ['seam', 'plant'], ['gap', 'plant'], ['late', 'plant'],
  ['overlap', 'plant'], ['missing', 'lab'], ['qualified', 'lab'],
  ['horizon', 'plant'], ['outside', 'plant'], ['seam', 'lab'],
] as const;
export const requirements = [['plant', 'electrical'], ['lab', 'electrical'], ['lab', 'chemical']] as const;
