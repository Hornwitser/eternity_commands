import * as lib from "@clusterio/lib";

export const plugin: lib.PluginDeclaration = {
	name: "eternity_commands",
	title: "Custom Eternity Cluster Commands",
	description: "Run custom commands.",
	ctlEntrypoint: "dist/plugin/ctl",
};
