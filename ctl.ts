import * as lib from "@clusterio/lib";
import type { Control } from "@clusterio/ctl";
import events from "node:events";
import { BaseCtlPlugin } from "@clusterio/ctl";
import stream from "node:stream";
import util from "node:util";
import fs from "node:fs";
import path from "node:path";

const finished = util.promisify(stream.finished);
const benchmarkInstanceStart = 3e9;
const benchmarkInstanceEnd = 3e9 + 1000;

function nextBenchmarkInstanceId(instances: lib.InstanceDetails[]) {
	const instanceIds = new Set(instances.map(i => i.id));
	for (let i = benchmarkInstanceStart; i < benchmarkInstanceEnd; i++) {
		if (!instanceIds.has(i)) {
			return i;
		}
	}
	throw new Error("No avaialble instance ids");
}

// To benchmark the following steps need to be automated
// Create new instances with custom settings, pattern name and assign it to host
// Upload reference save from reference instance + save name
// Start instance
async function createBenchmark(
	control: Control,
	hostId: number,
	saveInstance: string,
	saveName: string,
	nameExtra = "",
) {
	let saveInstanceId = await lib.resolveInstance(control, saveInstance);

	let instances = await control.sendTo("controller", new lib.InstanceDetailsListRequest());
	let hosts = new Map((await control.sendTo("controller", new lib.HostListRequest())).map(h => [h.id, h]));
	let newId = nextBenchmarkInstanceId(instances);
	let instanceConfig = new lib.InstanceConfig("control");
	instanceConfig.set("instance.id", newId);
	instanceConfig.set("instance.name", `Benchmark ${hosts.get(hostId)!.name}${nameExtra}`);
	instanceConfig.set("inventory_sync.load_plugin" as any, false);
	instanceConfig.set("player_auth.load_plugin" as any, false);
	instanceConfig.setProp("factorio.settings", "non_blocking_saving", true);
	instanceConfig.setProp("factorio.settings", "visibility", {"public": false, "lan": true});
	const serializedConfig = instanceConfig.toRemote("controller");
	console.log(`Creating instance ${instanceConfig.get("instance.name")}`);
	await control.send(new lib.InstanceCreateRequest(serializedConfig));
	console.log(`Assinging instance to ${hosts.get(hostId)!.name}`);
	await control.send(new lib.InstanceAssignRequest(newId, hostId));
	console.log(`Copying ${saveName}`);
	await control.send(new lib.InstanceTransferSaveRequest(
		saveInstanceId,
		saveName,
		newId,
		saveName,
		true,
	));
	return newId;
}

const eternityCommands = new lib.CommandTree({
	name: "ec", description: "Eternity Cluster custom commands",
});
eternityCommands.add(new lib.Command({
	definition: ["create-benchmark <target-host> <save-instance> <save-name>", "", (yargs) => {
		yargs.positional("target-host", { describe: "host to create benchmark on", type: "string" });
		yargs.positional("save-instance", { describe: "Source instance for save", type: "string" });
		yargs.positional("save-name", { describe: "Save to create", type: "string" });
	}],
	handler: async function(args: { targetHost: string, saveInstance: string, saveName: string }, control: Control) {
		let hostId = await lib.resolveHost(control, args.targetHost);
		await createBenchmark(control, hostId, args.saveInstance, args.saveName);
	},
}));

eternityCommands.add(new lib.Command({
	definition: ["auto-benchmark <host-count> <instance-count> <save-instance> <save-name> [host-name]", "", (yargs) => {
		yargs.positional("host-count", { describe: "how many hosts to start on", type: "number" });
		yargs.positional("instance-count", { describe: "max instances per host", type: "number" });
		yargs.positional("save-instance", { describe: "Source instance for save", type: "string" });
		yargs.positional("save-name", { describe: "Save to create", type: "string" });
		yargs.positional("host-name", { describe: "host to launch on", type: "string" });
	}],
	handler: async function(args: { hostName?: string, hostCount: number, instanceCount: number, saveInstance: string, saveName: string }, control: Control) {
		const hosts = new Map((await control.sendTo("controller", new lib.HostListRequest())).map(h => [h.id, h]));
		const instances = new Map((await control.sendTo("controller", new lib.InstanceDetailsListRequest())).map(i => [i.id, i]));
		const hostBenchmarkInstances = new Map([...hosts.values()].map(host => {
			return [host.id, [...instances.values()].filter(i => i.assignedHost === host.id)];
		}));
		let installed = 0;

		const sysInfo = new Map<string | number, lib.SystemInfo>();
		control.handle(lib.SystemInfoUpdateEvent, async (event) => {
			for (let s of event.updates) {
				sysInfo.set(s.id, s);
			}
		});
		await control.send(new lib.SubscriptionRequest(lib.SystemInfoUpdateEvent.name, true));
		await control.send(new lib.SubscriptionRequest(lib.SystemInfoUpdateEvent.name, false));

		while (installed < args.hostCount && hostBenchmarkInstances.size) {
			let [[candidateHostId, candidateInstances]] = hostBenchmarkInstances;
			hostBenchmarkInstances.delete(candidateHostId);
			const existingCount = candidateInstances.filter(
				i => i.id >= benchmarkInstanceStart && i.id <= benchmarkInstanceEnd
			).length;
			const host = hosts.get(candidateHostId)!;
			if (host.name !== args.hostName) {
				continue
			}
			const si = sysInfo.get(host.id)!;
			console.log("considering", host.name, "existing", existingCount);
			if (existingCount >= args.instanceCount) {
				console.log("skipping instance limit reached");
				continue;
			}
			if (!hosts.get(candidateHostId)!.connected) {
				console.log("skipping host offline");
				continue;
			}
			console.log(`cpu available ${si.cpuAvailable}`);
			if (si.cpuAvailable < 4) {
				console.log(`skipping cpu available < 4`);
				continue;
			}
			console.log("Creating benchmark instance");
			installed += 1;
			const extra = existingCount ? ` ${existingCount + 1}` : "";
			const newId = await createBenchmark(control, candidateHostId, args.saveInstance, args.saveName, extra);
			console.log("starting instance");
			try {
				await control.sendTo({ instanceId: newId }, new lib.InstanceStartRequest(args.saveName));
			} catch (err: any) {
				console.log("starting failed", err.message);
			}
		}
	},
}));

eternityCommands.add(new lib.Command({
	definition: ["host-need-update <host-version>", "", (yargs) => {
		yargs.positional("host-version", { describe: "version to check against", type: "string" });
	}],
	handler: async function(args: { hostVersion: string }, control: Control) {
		const hosts = new Map((await control.sendTo("controller", new lib.HostListRequest())).map(h => [h.id, h]));
		const list = [];
		for (const host of hosts.values()) {
			if (host.connected && host.version !== args.hostVersion) {
				list.push(host.name);
			}
		}
		console.log(list.join(" "));
	},
}));

async function downloadSave(control: Control, instanceId: number, save: string, savePath: string) {
	let streamId = await control.send(new lib.InstanceDownloadSaveRequest(instanceId, save));

	let url = new URL(control.config.get("control.controller_url")!);
	url.pathname += `api/stream/${streamId}`;
	console.log(`fetch ${url}`);
	let response = await fetch(url);

	const file = await response.blob();
	await fs.promises.writeFile(savePath, Buffer.from(await file.arrayBuffer()));
	console.log(`Downloaded ${save} as ${savePath}`);
}

function filterSaves(saves: lib.SaveDetails[], intervalMs: number, lastMs: number) {
	let remaining = [...saves].sort((a, b) => a.mtimeMs - b.mtimeMs);
	const result: lib.SaveDetails[] = [];
	while (remaining.length) {
		remaining = remaining.filter(s => s.mtimeMs > lastMs + intervalMs);
		if (remaining.length) {
			const save = remaining.shift()!;
			result.push(save);
			lastMs = save.mtimeMs;
		}
	}
	return result;
}

async function findLastSaveMs(folder: string) {
	const saves = await fs.promises.readdir(folder);
	const times = saves.map(s => Date.parse(s.replace(/(.*)T(.*)[_-](.*)[_-](.*)\.zip/, "$1T$2:$3:$4")));
	return Math.max(0, ...times);
}

eternityCommands.add(new lib.Command({
	definition: ["dl-saves <folder> [interval]", "", (yargs) => {
		yargs.positional("folder", { describe: "folder to download to", type: "string" });
		yargs.positional("interval", { describe: "how close saves can be in seconds", type: "number", default: 3000 })
	}],
	handler: async function(args: { folder: string, interval: number }, control: Control) {
		const hosts = new Map((await control.sendTo("controller", new lib.HostListRequest())).map(h => [h.id, h]));
		const instances = new Map((await control.sendTo("controller", new lib.InstanceDetailsListRequest())).map(i => [i.id, i]));
		const allSaves = await control.send(new lib.InstanceSaveDetailsListRequest());
		for (const instance of instances.values()) {
			const host = hosts.get(instance.assignedHost!);
			if (!host || !host.connected) {
				continue;
			}
			const saves = allSaves.filter(s => s.instanceId == instance.id);
			await fs.promises.mkdir(`${args.folder}/${instance.name}`, { recursive: true });
			const lastMs = await findLastSaveMs(`${args.folder}/${instance.name}`);
			for (const save of filterSaves(saves, args.interval * 1000, lastMs)) {
				const name = new Date(save.mtimeMs).toISOString().replace(/:/g, "_") + ".zip";
				const savePath = `${args.folder}/${instance.name}/${name}`;
				if (save.size > 100e6) {
					console.log(`skipping, ${instance.name} ${save.name} > 100 MB`);
					continue
				}
				console.log(`Downloading ${savePath} ${save.size / 1e6} MB`);
				try {
					await downloadSave(control, instance.id, save.name, savePath);
				} catch (err:any) {
					console.log(err.message);
					if (!(err instanceof lib.RequestError)) {
						throw err;
					}
				}
			}
		}
	},
}));

const productionMapString = `\
>>>eNpjZGBkSGcAgwZ7IGHPwZKcn5gD5QHBAQeu5PyCgtQi3fyiV
GRhzuSi0pRU3fxMVMWpeam5lbpJicVIihvsOTKL8vPQTWAtLsnPQ
xUpKUpNLYaIQDB3aVFiXmZpLrpeBsZpP0/GNLTIMYDw/3oGhf//Q
RjIegBUAMIMjA1gHYxAMRhgTc7JTEtjYFBwBGInkDQjA2O1yDr3h
1VTgEww0HOAMj5ARQ4kwUQ8YQw/B5xSKjCGCZI5xmDwGYkBsbQEZ
D9EFYcDggGRbAFJMjL2vt264PuxC3aMf1Z+vOSblGDPaOgq8u6D0
To7oCQ7yJ9McGLWTBDYCfMKA8zMB/ZQqZv2jGfPgMAbe0ZWkA4RE
OFgASQOeDMzMArwAVkLeoCEggwDzGl2MGNEHBjTwOAbzCePYYzL9
uj+AAaEDchwORBxAkSALYS7jBHCdOh3YHSQh8lKIpQA9RsxILshB
eHDkzBrDyPZj+YQzIhA9geaiIoDlmjgAlmYAideMMNdAwzPC+wwn
sN8B0ZmEAOk6gtQDMIDycCMgtACDuDgZmZAgA/2DD9b9hUDAFAxn
s8=<<<`;

eternityCommands.add(new lib.Command({
	definition: ["create-instance <name> <host>", "", (yargs) => {
		yargs.positional("name", { describe: "name of the new instance", type: "string" });
		yargs.positional("host", { describe: "host to create instance on", type: "string" })
		yargs.option("username", { type: "string", nargs: 1, describe: "Factorio username" });
		yargs.option("token", { type: "string", nargs: 1, describe: "Factorio token" });
		yargs.option("game-password", { type: "string", nargs: 1, describe: "Factorio game password to set" });
	}],
	handler: async function(args: {
		name: string,
		host: string,
		username: string,
		token: string,
		gamePassword: string,
	}, control: Control) {
		const hostId = await lib.resolveHost(control, args.host);
		let instanceConfig = new lib.InstanceConfig("control");
		instanceConfig.set("instance.name", args.name);
		instanceConfig.set("instance.auto_start", true);
		instanceConfig.set("factorio.enable_authserver_bans", true);
		instanceConfig.set("factorio.player_online_autosave_slots", 50);
		if (args.username) { instanceConfig.setProp("factorio.settings", "username", args.username); }
		if (args.token) { instanceConfig.setProp("factorio.settings", "token", args.token); }
		if (args.gamePassword) { instanceConfig.setProp("factorio.settings", "game_password", args.gamePassword); }
		instanceConfig.setProp("factorio.settings", "non_blocking_saving", true);
		instanceConfig.set("player_auth.load_plugin" as any, false);
		const serializedConfig = instanceConfig.toRemote("controller");
		const instanceId = instanceConfig.get("instance.id");

		console.log(`Creating instance ${instanceConfig.get("instance.name")}`);
		await control.send(new lib.InstanceCreateRequest(serializedConfig));
		console.log(`Assinging instance to ${args.host}`);
		await control.send(new lib.InstanceAssignRequest(instanceId, hostId));
		console.log(`Creating ${args.name}-world.zip`);
		const parsed = lib.readMapExchangeString(productionMapString);
		await control.sendTo({ instanceId }, new lib.InstanceCreateSaveRequest(
			`${args.name}-world.zip`,
			Math.floor(Math.random() * 2**53),
			parsed.map_gen_settings,
			parsed.map_settings,
		));
		console.log("Starting instance");
		await control.sendTo({ instanceId }, new lib.InstanceStartRequest());
	},
}));

export class CtlPlugin extends BaseCtlPlugin {
	async addCommands(rootCommand: lib.CommandTree) {
		rootCommand.add(eternityCommands);
	}
}
