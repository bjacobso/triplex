export const DAY = 86_400_000;

/** A small deterministic generator, so a seeded database is the same every time. */
export const prng = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const firstNames = [
  "Maria",
  "Dana",
  "Priya",
  "Sam",
  "Jonah",
  "Aisha",
  "Luis",
  "Mei",
  "Tomas",
  "Grace",
  "Omar",
  "Nina",
  "Kofi",
  "Hana",
  "Ravi",
  "Elena",
  "Marcus",
  "Ines",
  "Yusuf",
  "Freya",
  "Diego",
  "Amara",
  "Viktor",
  "Leila",
  "Theo",
  "Sofia",
  "Kenji",
  "Rosa",
  "Ibrahim",
  "Clara",
] as const;

export const lastNames = [
  "Okafor",
  "Lindqvist",
  "Patel",
  "Nakamura",
  "Garcia",
  "Haddad",
  "Novak",
  "Mensah",
  "Kowalski",
  "Ferreira",
  "Chen",
  "O'Brien",
  "Rahman",
  "Silva",
  "Andersen",
  "Dubois",
  "Kim",
  "Moreno",
  "Abiodun",
  "Petrov",
  "Rossi",
  "Tanaka",
  "Walsh",
  "Schmidt",
  "Ortiz",
  "Nguyen",
  "Ali",
  "Brennan",
] as const;

export const siteNames = [
  "Harbor",
  "Ridgeway",
  "Foundry",
  "Millbrook",
  "Northgate",
  "Cedar Point",
  "Ironworks",
  "Lakeside",
  "Quarry Hill",
  "Riverside",
  "Summit",
  "Westfield",
  "Eastport",
  "Granite Bay",
  "Oakridge",
  "Pine Hollow",
  "Redstone",
  "Silverlake",
  "Thornbury",
  "Valley Forge",
  "Willow Creek",
  "Yardley",
  "Bayview",
  "Copperfield",
] as const;

export const summaries = [
  "Forklift near miss at loading dock",
  "Slip on wet floor in break room",
  "Scaffold guardrail missing on level 3",
  "Unlabelled chemical container found",
  "Hot work permit not displayed",
  "Minor hand laceration during cutting",
  "Blocked emergency exit corridor",
  "Electrical panel left open",
  "Dropped tool from height, no injury",
  "Confined space entry without attendant",
  "Hearing protection not worn in press shop",
  "Ladder with damaged rung in use",
] as const;
