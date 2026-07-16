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

// Workspace dependencies can resolve through different symlink paths, which causes Metro to
// treat them as distinct module instances. Intercept resolution before Metro follows symlinks and
// re-root the lookup to playground's node_modules so every workspace file gets the same instance.
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
