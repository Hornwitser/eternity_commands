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

function filterSaves(saves: lib.SaveDetails[], intervalMs: number, lastMs: number, excludeAutosaves: boolean) {
	let remaining = [...saves].sort((a, b) => a.mtimeMs - b.mtimeMs);
	if (excludeAutosaves) {
		remaining = remaining.filter(s => !/^_autosave[0-9]+\.zip$/.test(s.name));
	}
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
	try {
		const saves = await fs.promises.readdir(folder);
		const times = saves.map(s => Date.parse(s.replace(/(.*)T(.*)[_-](.*)[_-](.*)\.zip/, "$1T$2:$3:$4")));
		return Math.max(0, ...times);
	} catch (err: any) {
		if (err.code === "ENOENT") {
			return 0;
		}
		throw err;
	}
}

eternityCommands.add(new lib.Command({
	definition: ["dl-saves <folder> [interval]", "", (yargs) => {
		yargs.positional("folder", { describe: "folder to download to", type: "string" });
		yargs.positional("interval", { describe: "how close saves can be in seconds", type: "number", default: 3000 })
		yargs.option("exclude-autosaves", { describe: "Ignore autosaves with no players online", type: "boolean", default: false });
		yargs.option("dry-run", { describe: "only print saves that would have been downloaded", type: "boolean", default: false });
	}],
	handler: async function(args: { folder: string, interval: number, excludeAutosaves: boolean, dryRun: boolean }, control: Control) {
		const hosts = new Map((await control.sendTo("controller", new lib.HostListRequest())).map(h => [h.id, h]));
		const instances = new Map((await control.sendTo("controller", new lib.InstanceDetailsListRequest())).map(i => [i.id, i]));
		const allSaves = await control.send(new lib.InstanceSaveDetailsListRequest());
		for (const instance of instances.values()) {
			const host = hosts.get(instance.assignedHost!);
			if (!host || !host.connected) {
				continue;
			}
			const saves = allSaves.filter(s => s.instanceId == instance.id);
			if (!args.dryRun) {
				await fs.promises.mkdir(`${args.folder}/${instance.name}`, { recursive: true });
			}
			const lastMs = await findLastSaveMs(`${args.folder}/${instance.name}`);
			for (const save of filterSaves(saves, args.interval * 1000, lastMs, args.excludeAutosaves)) {
				const name = new Date(save.mtimeMs).toISOString().replace(/:/g, "_") + ".zip";
				const savePath = `${args.folder}/${instance.name}/${name}`;
				if (save.size > 100e6) {
					console.log(`skipping, ${instance.name} ${save.name} > 100 MB`);
					continue
				}
				console.log(`Downloading ${instance.name}:${save.name} as ${savePath} ${save.size / 1e6} MB`);
				if (args.dryRun) {
					continue;
				}
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
		yargs.option("seed", { describe: "Seed to use, takes precedence over the seed in --map-string", nargs: 1, type: "number" });
		yargs.option("randomize-seed", { type: "boolean", describe: "like --seed but use a random one", default: false });
		yargs.option("map-string", { describe: "Map string to use, uses production map by default", nargs: 1, type: "string" });
		yargs.option("token", { type: "string", nargs: 1, describe: "Factorio token" });
		yargs.option("game-password", { type: "string", nargs: 1, describe: "Factorio game password to set" });
	}],
	handler: async function(args: {
		name: string,
		seed?: number,
		mapString?: string,
		randomizeSeed: boolean,
		host: string,
		username: string,
		token: string,
		gamePassword: string,
	}, control: Control) {
		if (args.seed !== undefined && args.randomizeSeed) {
			console.error("--seed and --randomize-seed are mutually exclusive");
			process.exitCode = 1;
			return;
		}
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
		const parsed = lib.readMapExchangeString(args.mapString ?? productionMapString);

		console.log(`Creating instance ${instanceConfig.get("instance.name")}`);
		await control.send(new lib.InstanceCreateRequest(serializedConfig));
		console.log(`Assinging instance to ${args.host}`);
		await control.send(new lib.InstanceAssignRequest(instanceId, hostId));
		console.log(`Creating ${args.name}-world.zip`);
		await control.sendTo({ instanceId }, new lib.InstanceCreateSaveRequest(
			`${args.name}-world.zip`,
			args.seed ?? (args.randomizeSeed ? Math.floor(Math.random() * 2**53) : undefined),
			parsed.map_gen_settings,
			parsed.map_settings,
		));
		console.log("Starting instance");
		await control.sendTo({ instanceId }, new lib.InstanceStartRequest());
	},
}));

const strcmp = Intl.Collator(undefined, { numeric: true }).compare;

eternityCommands.add(new lib.Command({
	definition: ["google-sheet-instances", "Print current instance to host mapping in google sheet friendly format", (yargs) => {
	}],
	handler: async function(
		args: { },
		control: Control,
	) {
		const instances = await control.sendTo("controller", new lib.InstanceDetailsListRequest());
		const hosts = new Map((await control.sendTo("controller", new lib.HostListRequest())).map(h => [h.id, h]));
		const mapping = instances.map(i => `${i.name},${hosts.get(i.assignedHost!)?.name}`);
		mapping.sort(strcmp);
		console.log(mapping.join("\n"));
	},
}));

eternityCommands.add(new lib.Command({
	definition: ["config-get <field>", "Get field in all instance configs", (yargs) => {
		yargs.positional("field", { describe: "Field to set", type: "string" });
	}],
	handler: async function(
		args: { instance: string, field: string, value?: string, stdin?: boolean },
		control: Control,
	) {
		const instances = await control.sendTo("controller", new lib.InstanceDetailsListRequest());
		for (const instance of instances) {
			const config = await control.send(new lib.InstanceConfigGetRequest(instance.id));
			console.log(instance.name, config[args.field])
		}
	},
}));
eternityCommands.add(new lib.Command({
	definition: ["config-set <field> [value]", "Set field in all instance configs", (yargs) => {
		yargs.positional("field", { describe: "Field to set", type: "string" });
		yargs.positional("value", { describe: "Value to set", type: "string" });
		yargs.options({
			"stdin": { describe: "read value from stdin", nargs: 0, type: "boolean" },
		});
	}],
	handler: async function(
		args: { instance: string, field: string, value?: string, stdin?: boolean },
		control: Control,
	) {
		if (args.stdin) {
			args.value = (await lib.readStream(process.stdin)).toString().replace(/\r?\n$/, "");
		} else if (args.value === undefined) {
			args.value = "";
		}
		const instances = await control.sendTo("controller", new lib.InstanceDetailsListRequest());
		for (const instance of instances) {
			await control.send(new lib.InstanceConfigSetFieldRequest(instance.id, args.field, args.value));
		}
	},
}));

eternityCommands.add(new lib.Command({
	definition: ["config-set-prop <field> <prop> [value]", "Set property of field in all instance configs", (yargs) => {
		yargs.positional("field", { describe: "Field to set", type: "string" });
		yargs.positional("prop", { describe: "Property to set", type: "string" });
		yargs.positional("value", { describe: "JSON parsed value to set", type: "string" });
		yargs.options({
			"stdin": { describe: "read value from stdin", nargs: 0, type: "boolean" },
		});
	}],
	handler: async function(
		args: { instance: string, field: string, prop: string, value?: string, stdin?: boolean },
		control: Control
	) {
		if (args.stdin) {
			args.value = (await lib.readStream(process.stdin)).toString().replace(/\r?\n$/, "");
		}
		let value;
		try {
			if (args.value !== undefined) {
				value = JSON.parse(args.value);
			}
		} catch (err: any) {
			if (args.stdin || /^(\[.*]|{.*}|".*")$/.test(args.value!)) {
				throw new lib.CommandError(`In parsing value '${args.value}': ${err.message}`);
			}
			value = args.value;
		}
		const instances = await control.sendTo("controller", new lib.InstanceDetailsListRequest());
		for (const instance of instances) {
			await control.send(new lib.InstanceConfigSetPropRequest(instance.id, args.field, args.prop, value));
		}
	},
}));

eternityCommands.add(new lib.Command({
	definition: ["rcon-all <command>", "Send RCON command to all instances", (yargs) => {
		yargs.positional("command", { describe: "command to send", type: "string" });
	}],
	handler: async function(args: { command: string }, control: Control) {
		const instances = await control.sendTo("controller", new lib.InstanceDetailsListRequest());
		await Promise.all(instances.map(async (instance) => {
			try {
				const response = await control.sendTo(
					{ instanceId: instance.id },
					new lib.InstanceSendRconRequest(args.command),
				);
				// Factorio includes a newline in its response output.
				process.stdout.write(`${instance.name}: ${response}`);
			} catch (err: any) {
				console.error(`${instance.name}: ${err.message}`);
			}
		}));
	},
}));


eternityCommands.add(new lib.Command({
	definition: ["migrate", "Migrate instances to other hosts", (yargs) => {
		yargs.option("instances", {
			describe: "Select instances to migrate",
			type: "string",
			array: true,
			default: [],
		});
		yargs.option("to-hosts", {
			describe: "Target hosts to migrate to. Will use round-robin assigment if more than one is provided",
			type: "string",
			required: true,
			array: true,
		});
		yargs.option("from-hosts", {
			describe: "Migrate all instances from the given host(s)",
			type: "string",
			array: true,
			default: [],
		});
	}],
	handler: async function(args: { instances: string[], fromHosts: string[], toHosts: string[] }, control: Control) {
		let instanceIds: number[] = [];
		const instanceMap = new Map(
			(await control.sendTo("controller", new lib.InstanceDetailsListRequest())).map(i => [i.id, i])
		);
		const hostMap = new Map(
			(await control.sendTo("controller", new lib.HostListRequest())).map(h => [h.id, h])
		);
		for (const instance of args.instances) {
			instanceIds.push(await lib.resolveInstance(control, instance));
		}
		for (const host of args.fromHosts) {
			const hostId = await lib.resolveHost(control, host)
			instanceIds.push(...[...instanceMap.values()].filter(i => i.assignedHost === hostId).map(i => i.id));
		}

		// Filter duplicates out
		instanceIds = [...new Set(instanceIds)];

		if (!instanceIds.length) {
			console.log("No instances to migrate selected");
			process.exitCode = 1;
			return;
		}

		const toHosts: lib.HostDetails[] = [];
		for (const host of args.toHosts) {
			const hostId = await lib.resolveHost(control, host);
			toHosts.push(hostMap.get(hostId)!);
		}

		if (!toHosts.length) {
			console.log("No hosts to migrate to provided.");
			process.exitCode = 1;
			return;
		}

		for (let i = 0; i < instanceIds.length; i++) {
			const instance = instanceMap.get(instanceIds[i])!;
			if (instance.assignedHost === undefined) {
				console.log(`Skipping ${instance.name} due to it not being assigned to any host.`);
				continue;
			}
			const sourceHost = hostMap.get(instance.assignedHost)!;
			const targetHost = toHosts[i % toHosts.length];
			if (sourceHost.id === targetHost.id) {
				console.log(`Skipping ${instance.name} as it's already on ${targetHost.name}`);
				continue;
			}

			if (instance.status !== "running" && instance.status !== "stopped") {
				console.log(`Skiping ${instance.name} as it's status is currently ${instance.status}`);
				continue;
			}

			console.log(`Migrating ${instance.name} from ${sourceHost.name} to ${targetHost.name}`);
			await migrateInstance(control, instance, sourceHost, targetHost);
		}
	}
}));

async function migrateInstance(
	control: Control,
	instance: lib.InstanceDetails,
	sourceHost: lib.HostDetails,
	targetHost: lib.HostDetails
) {
	const running = instance.status === "running";
	if (running) {
		console.log("Stopping instance");
		await control.sendTo({ instanceId: instance.id }, new lib.InstanceStopRequest());
	}

	// This is somewhat inefficient
	const save = (
		await control.sendTo("controller", new lib.InstanceSaveDetailsListRequest())
	).find(s => s.instanceId === instance.id && s.loadByDefault);

	if (!save) {
		console.log(`Failed to migrate ${instance.name}: unable to find save which would be loaded`);
		return;
	}

	const localName = `${instance.name} ${new Date(save.mtimeMs).toISOString().replace(/:/g, "_")}.zip`
	console.log(`Downloading ${save.name} as ${localName}`)
	await streamDownloadSave(control, instance.id, save.name, localName);

	console.log(`Reassigning to ${targetHost.name}`);
	await control.sendTo("controller", new lib.InstanceAssignRequest(instance.id, targetHost.id));

	console.log(`Uploading ${localName}`);
	const remoteName = await streamUploadSave(control, instance.id, localName);

	if (running) {
		console.log("Starting instance");
		await control.sendTo({ instanceId: instance.id }, new lib.InstanceStartRequest(remoteName));
	}
}

async function streamDownloadSave(control: Control, instanceId: number, remoteName: string, localName: string) {
	let streamId = await control.send(new lib.InstanceDownloadSaveRequest(instanceId, remoteName));

	let url = new URL(control.config.get("control.controller_url")!);
	url.pathname += `api/stream/${streamId}`;
	let response = await fetch(url.href);

	let writeStream;
	let tempFilename = localName.replace(/(\.zip)?$/, ".tmp.zip");
	while (true) {
		try {
			writeStream = fs.createWriteStream(tempFilename, { flags: "wx" });
			await events.once(writeStream, "open");
			break;
		} catch (err: any) {
			if (err.code === "EEXIST") {
				tempFilename = await lib.findUnusedName(".", tempFilename, ".tmp.zip");
			} else {
				throw err;
			}
		}
	}
	//@ts-expect-error Broken types
	stream.Readable.fromWeb(response.body!).pipe(writeStream);
	await finished(writeStream);

	await fs.promises.rename(tempFilename, localName);
}

async function streamUploadSave(control: Control, instanceId: number, localName: string) {
	const file = await fs.promises.open(localName);
	const url = new URL(control.config.get("control.controller_url")!);
	url.pathname += "api/upload-save";
	url.searchParams.append("instance_id", String(instanceId));
	url.searchParams.append("filename", localName);

	type ResponseData = { errors?: string[], request_errors?: string[], saves?: string[] };
	let response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"X-Access-Token": control.config.get("control.controller_token")!,
				"Content-Type": "application/zip",
			},
			body: file.readableWebStream({ type: "bytes" }) as ReadableStream,
			//@ts-ignore duplex is missing in type
			duplex: "half",
		});
	} catch (err: any) {
		if (err.cause) {
			throw err.cause;
		}
		throw err;
	}
	const result = await response.json() as ResponseData;


	for (let error of result.errors || []) {
		console.error(error);
	}

	for (let requestError of result.request_errors || []) {
		console.error(requestError);
	}

	if (
		(result.errors || []).length
		|| (result.request_errors || []).length
		|| !result.saves
		|| !result.saves.length
	) {
		throw new lib.CommandError("Uploading save failed");
	}

	return result.saves![0];
}


export class CtlPlugin extends BaseCtlPlugin {
	async addCommands(rootCommand: lib.CommandTree) {
		rootCommand.add(eternityCommands);
	}
}
