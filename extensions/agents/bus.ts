/**
 * Centralized UIBus producer for primary-mode state.
 *
 * Every primary state change in extensions/agents/ funnels through
 * publishMode here so there is exactly one producer call site.
 */

export { publishMode } from "../ui/bus.js";
