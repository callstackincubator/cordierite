const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
	path.resolve(projectRoot, "node_modules"),
	path.resolve(workspaceRoot, "node_modules"),
];

// Bun installs separate physical copies of these packages per workspace (different
// content-addressable store hashes), which causes Metro to treat them as distinct
// module instances. We intercept resolution before Metro follows any symlinks and
// re-root the lookup to playground's node_modules so every workspace file gets the
// same single instance.
const SHARED_DEPS = [
	"react",
	"react-dom",
	"react-native",
	"expo",
	"expo-modules-core",
];

config.resolver.resolveRequest = (context, moduleName, platform) => {
	const isShared = SHARED_DEPS.some(
		(dep) => moduleName === dep || moduleName.startsWith(`${dep}/`),
	);
	if (isShared) {
		return context.resolveRequest(
			{ ...context, originModulePath: path.join(projectRoot, "index.js") },
			moduleName,
			platform,
		);
	}
	return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
