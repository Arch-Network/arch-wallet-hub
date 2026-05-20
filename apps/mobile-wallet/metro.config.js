const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const sdkRoot = path.resolve(projectRoot, "../../packages/wallet-hub-sdk");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [sdkRoot];

config.resolver.extraNodeModules = {
  "@arch/wallet-hub-sdk": sdkRoot,
};

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
];

module.exports = config;
