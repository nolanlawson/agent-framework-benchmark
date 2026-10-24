// The frameworks under test. The key is what you pass to --frameworks; the label is
// what the agent is told to use. Tooling per framework lives in agent/setup-tooling.sh.
export const FRAMEWORKS = {
  next: 'Next.js',
  nuxt: 'Nuxt',
  'tanstack-start': 'TanStack Start with React',
  'react-router': 'React Router in framework mode',
  solidstart: 'SolidStart',
  sveltekit: 'SvelteKit',
  angular: 'Angular',
  astro: 'Astro',
  qwik: 'Qwik with Qwik City',
  gracile: 'Gracile with Lit',
  'hono-htmx': 'Hono and htmx',
  vanilla: 'vanilla JavaScript or TypeScript with Vite, without a UI framework',
};

// The only thing that differs between agents is the framework label.
export const prompt = (label) =>
  `Implement the app described in SPEC.md using ${label}. Use the latest stable version. ` +
  'Work autonomously until `npm test` passes.';
