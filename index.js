var fs = require('fs');
var path = require('path');
var util = require('util');
var ts = require('typescript-api');
var sm = require('source-map');
var loaderUtils = require('loader-utils');

var kCompilationOptions = (function () {
  var settings = new ts.CompilationSettings();
  settings.codeGenTarget = ts.LanguageVersion.EcmaScript5;
  settings.moduleGenTarget = ts.ModuleGenTarget.Synchronous;
  settings.mapSourceFiles = true;
  return ts.ImmutableCompilationSettings.fromCompilationSettings(settings);
})();

function handleDiagnostic(loader, diag) {
  var wasError = false;
  var info = diag.info();
  var formattedMessage = util.format("%s(%d,%d) %s", diag.fileName(), diag.line()+1, diag.character()+1, diag.text());
  if (info.category == ts.DiagnosticCategory.Warning) {
    loader.emitWarning(formattedMessage);
  } else if (info.category == ts.DiagnosticCategory.Error) {
    loader.emitError(formattedMessage);
    wasError = true;
  } else {
    console.info(info.message);
  }
  return wasError;
}

function dumpDiagnostics(loader, diagnostics) {
  var hadErrors = false;
  diagnostics.forEach(function (diag) {
    var wasError = handleDiagnostic(loader, diag);
    hadErrors = hadErrors || wasError;
  });
  return hadErrors;
}

function useCache() {
  var query = loaderUtils.parseQuery(this.query);
  
  var cacheIsDisabled = (query.cache === 'false');

  return !cacheIsDisabled;  
}

var kResolverHost = {
  snapshotCache: {},
  getScriptSnapshot: function (fileName) {
    var snapshot = this.snapshotCache[fileName];
    if (!useCache() || !snapshot) {
      snapshot = this.snapshotCache[fileName] = ts.ScriptSnapshot.fromString(fs.readFileSync(fileName).toString());
    }
    return snapshot;
  },
  resolveRelativePath: function (file, from) {
    return path.resolve(from, file);
  },
  fileExists: function (path) {
    return fs.existsSync(path);
  },
  directoryExists: function (path) {
    return fs.existsSync(path) && fs.statSync(path).isDirectory();
  },
  getParentDirectory: function (p) {
    var dir = path.dirname(p);
    return dir === p ? null : dir;
  },
};

function Instance() {
  this.compiler = new ts.TypeScriptCompiler(new ts.NullLogger(), kCompilationOptions);
  this.dependencies = {};
}

Instance.prototype = {
  addFileIfNecessary: function (path, references) {
    if (useCache() && this.dependencies[path]) {
      return;
    }
    var scriptSnapshot = kResolverHost.getScriptSnapshot(path);
    this.dependencies[path] = true;
    this.compiler.addFile(
      path,
      scriptSnapshot,
      ts.ByteOrderMark.Utf8,
      0, // version
      true, // isOpen
      references); // referencedFiles
  },
  clearDependencies: function () {
    this.dependencies = [];
  },
  compiledOutputFor: function (sourcePath, source) {
    var output = this.compiler.emit(sourcePath, function (pathToResolve) {
      throw new Error("No idea how to resolve path " + pathToResolve);
    });

    var transformedSource;
    var sourceMap;

    output.outputFiles.forEach(function (f) {
      if (f.fileType == ts.OutputFileType.JavaScript) {
        // Strip the source map reference as it's not needed and is a bit confusing.
        transformedSource = f.text.replace(/\/\/# sourceMappingURL=.+/, "", "m");;
      } else if (f.fileType == ts.OutputFileType.SourceMap) {
        sourceMap = JSON.parse(f.text);
      }
    });

    if (sourceMap) {
      delete sourceMap.file;
      sourceMap.sources = [path.relative(path.resolve('.'), sourcePath)];
      sourceMap.sourcesContent = [source];
    }

    return {
      source: transformedSource,
      sourceMap: sourceMap,
    };
  }
};

var kInstance = new Instance();

module.exports = function (source) {
  this.cacheable && this.cacheable(true);

  useCache  = useCache.bind(this);

  if(!useCache()) {
    kInstance.clearDependencies();
  }

  var hadErrors = false;

  var resolutionResults = ts.ReferenceResolver.resolve([this.resourcePath], kResolverHost, true);

  resolutionResults.diagnostics.forEach(function (diag) {
    var wasError = handleDiagnostic(this, diag);
    hadErrors = hadErrors || wasError;
  }, this);

  if (hadErrors) {
    return this.callback("Failed during compilation");
  }

  // Load the standard library out of the typescript module itself
  var typescriptDefaultLib = path.dirname(require.resolve('typescript')) + "/lib.d.ts";
  this.addDependency(typescriptDefaultLib);
  kInstance.addFileIfNecessary(typescriptDefaultLib);
  resolutionResults.resolvedFiles.forEach(function (file) {
    this.addDependency(file.path);
    kInstance.addFileIfNecessary(file.path, file.referencedFiles);
  }, this);

  // Start looking for errors
  resolutionResults.resolvedFiles.forEach(function (file) {
    var syntaxErrors = kInstance.compiler.getSyntacticDiagnostics(file.path);
    if (syntaxErrors.length > 0) {
      dumpDiagnostics(this, syntaxErrors);
      hadErrors = true;
      return;
    }
    var semanticErrors = kInstance.compiler.getSemanticDiagnostics(file.path);
    if (semanticErrors.length > 0) {
      dumpDiagnostics(this, semanticErrors);
      hadErrors = true;
      return;
    }
  }, this);

  if (hadErrors) {
    return this.callback("Failed during compilation");
  }

  var output = kInstance.compiledOutputFor(this.resourcePath, source);

  this.compiled = true;
  return this.callback(null, output.source, output.sourceMap);
}
