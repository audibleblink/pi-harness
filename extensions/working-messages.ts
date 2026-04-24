/**
 * Working Messages Extension
 *
 * Picks a random "Working..." message from a list each time pi starts responding.
 * The message is shown as a static working indicator while streaming.
 *
 * Customize MESSAGES below to add your own strings.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const MESSAGES = [
	"Hyperspace charging...",
	"Initiating lightspeed...",
	"Jedi training commencing...",
	"Lightsaber calibrating...",
	"Force awakening...",
	"Scanning for Rebel bases...",
	"Analyzing star charts...",
	"Darth loading protocols...",
	"Warp drive initializing...",
	"Imperial systems booting...",
	"Millennium Falcon priming...",
	"Death Star powering up...",
	"Blaster charging capacity...",
	"Droid activation sequence...",
	"Wookiee strength gathering...",
	"Bounty hunter tracking...",
	"Cantina band tuning...",
	"Hologram projecting data...",
	"Asteroids approaching detected...",
	"Stormtrooper formations loading...",
	"Yoda wisdom accessing...",
	"Padawan skills sharpening...",
	"Sith power rising...",
	"Rebellion planning strategy...",
	"Empire expanding control...",
	"Tatooine suns setting...",
	"Dagobah swamps deepening...",
	"Endor battle commencing...",
	"Bespin cloud city...",
	"Kashyyyk forests awakening...",
	"Geonosis army rising...",
	"Utapau platforms rotating...",
	"Mustafar lava flowing...",
	"Coruscant towers loading...",
	"Naboo palaces activating...",
	"Ewok drums beating...",
	"Tusken Raiders calling...",
	"Sandcrawler moving slowly...",
	"Jawas bargaining prices...",
	"Cantina patrons arriving...",
	"Jabba palace opening...",
	"Carbonite freezing process...",
	"Hyperspace jump initiating...",
	"Asteroid field dodging...",
	"TIE fighter launching...",
	"X-wing engines roaring...",
	"Speeder bike accelerating...",
	"Podrace engines starting...",
	"Clone trooper marching...",
	"Droid army assembling...",
	"Separatist forces gathering...",
	"Battle droids activating...",
	"Super battle droids...",
	"General Grievous awakening...",
	"Count Dooku scheming...",
	"Palpatine's plans unfolding...",
	"Emperor's will strengthening...",
	"Dark side consuming...",
	"Light side balancing...",
	"Younglings training hard...",
	"Temple defenses activating...",
	"Order 66 executing...",
	"Purge commencing execution...",
	"Inquisitor hunting survivors...",
	"Rebels hiding carefully...",
	"Resistance fighters preparing...",
	"First Order rising...",
	"Snoke's dominion expanding...",
	"Supreme Leader commanding...",
	"Kylo Ren angered...",
	"Rey's powers growing...",
	"Finn's courage rising...",
	"Poe's piloting improving...",
	"BB-8 beeping happily...",
	"C-3PO translating languages...",
	"R2-D2 whistling codes...",
	"Chewbacca roaring loudly...",
	"Han's charm activating...",
	"Leia's leadership shining...",
	"Luke's legend growing...",
	"Vader's breathing echoing...",
	"Obi-Wan's wisdom loading...",
	"Qui-Gon meditating...",
	"Mace Windu focused...",
	"Anakin's passion rising...",
	"Padmé's grace appearing...",
	"Jar Jar stumbling around...",
	"Yoda's age showing...",
	"Grogu's powers emerging...",
	"Din Djarin traveling...",
	"Boba Fett hunting...",
	"Cad Bane scheming...",
	"TIE Interceptor speeding...",
	"Star Destroyer commanding...",
	"Mon Calamari cruising...",
	"Rebel Alliance rising...",
	"Galactic Empire ruling...",
];

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function pick<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)]!;
}

function makeFrames(ctx: { ui: { theme: { fg: (color: string, text: string) => string } } }) {
	return SPINNER_FRAMES.map((frame) => ctx.ui.theme.fg("dim", frame));
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setWorkingIndicator({ frames: makeFrames(ctx), intervalMs: 80 });
		ctx.ui.setWorkingMessage(pick(MESSAGES));
	});

	pi.on("request_start", (_event, ctx) => {
		// Pick a new random message each time the model starts responding
		ctx.ui.setWorkingMessage(pick(MESSAGES));
	});
}
