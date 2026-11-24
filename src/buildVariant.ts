// Which installer this renderer bundle was built as — set at build time via
// Vite's VITE_BUILD_VARIANT env var (see package.json's build:actor script
// and electron-builder.actor.yml). Anything other than "actor" is the full
// build, so an unset/missing env var (dev server, an old build) always
// falls back to the full app rather than accidentally hiding things.
//
// The actor-lite installer exists for dabbers (profiles whose only role is
// "actor") on a machine with no reason to carry the separation/GPU/model-
// browser/power-share UI — none of it does anything useful without the ML
// stack that build's own backend was built without (see build-backend.py's
// --actor flag), so it's hidden rather than left to fail at runtime.
export const IS_ACTOR_BUILD = import.meta.env.VITE_BUILD_VARIANT === 'actor'
