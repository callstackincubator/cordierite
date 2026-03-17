module.exports = {
  dependency: {
    platforms: {
      android: {
        packageImportPath:
          "import com.callstackincubator.cordierite.CordieritePackage;",
        packageInstance: "new CordieritePackage()",
      },
      ios: {},
    },
  },
};
