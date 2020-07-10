import * as types from "./types";
import * as protocol from "./stdio_protocol";

function validateTarget(target: string): string {
  target += ''
  if (target.indexOf(',') >= 0) throw new Error(`Invalid target: ${target}`)
  return target
}

function pushCommonFlags(flags: string[], options: types.CommonOptions, isTTY: boolean, logLevelDefault: types.LogLevel): void {
  if (options.target) {
    if (options.target instanceof Array) flags.push(`--target=${Array.from(options.target).map(validateTarget).join(',')}`)
    else flags.push(`--target=${validateTarget(options.target)}`)
  }
  if (options.strict === true) flags.push(`--strict`);
  else if (options.strict) for (let key of options.strict) flags.push(`--strict:${key}`);

  if (options.minify) flags.push('--minify');
  if (options.minifySyntax) flags.push('--minify-syntax');
  if (options.minifyWhitespace) flags.push('--minify-whitespace');
  if (options.minifyIdentifiers) flags.push('--minify-identifiers');

  if (options.jsxFactory) flags.push(`--jsx-factory=${options.jsxFactory}`);
  if (options.jsxFragment) flags.push(`--jsx-fragment=${options.jsxFragment}`);
  if (options.define) for (let key in options.define) flags.push(`--define:${key}=${options.define[key]}`);
  if (options.pure) for (let fn of options.pure) flags.push(`--pure:${fn}`);

  if (options.color) flags.push(`--color=${options.color}`);
  else if (isTTY) flags.push(`--color=true`); // This is needed to fix "execFileSync" which buffers stderr
  flags.push(`--log-level=${options.logLevel || logLevelDefault}`);
  flags.push(`--error-limit=${options.errorLimit || 0}`);
}

function flagsForBuildOptions(options: types.BuildOptions, isTTY: boolean): string[] {
  let flags: string[] = [];
  pushCommonFlags(flags, options, isTTY, 'info');

  if (options.sourcemap) flags.push(`--sourcemap${options.sourcemap === true ? '' : `=${options.sourcemap}`}`);
  if (options.globalName) flags.push(`--global-name=${options.globalName}`);
  if (options.bundle) flags.push('--bundle');
  if (options.splitting) flags.push('--splitting');
  if (options.metafile) flags.push(`--metafile=${options.metafile}`);
  if (options.outfile) flags.push(`--outfile=${options.outfile}`);
  if (options.outdir) flags.push(`--outdir=${options.outdir}`);
  if (options.platform) flags.push(`--platform=${options.platform}`);
  if (options.format) flags.push(`--format=${options.format}`);
  if (options.resolveExtensions) flags.push(`--resolve-extensions=${options.resolveExtensions.join(',')}`);
  if (options.external) for (let name of options.external) flags.push(`--external:${name}`);
  if (options.loader) for (let ext in options.loader) flags.push(`--loader:${ext}=${options.loader[ext]}`);

  for (let entryPoint of options.entryPoints) {
    entryPoint += '';
    if (entryPoint.startsWith('-')) throw new Error(`Invalid entry point: ${entryPoint}`);
    flags.push(entryPoint);
  }

  return flags;
}

function flagsForTransformOptions(options: types.TransformOptions, isTTY: boolean): string[] {
  let flags: string[] = [];
  pushCommonFlags(flags, options, isTTY, 'silent');

  if (options.sourcemap) flags.push(`--sourcemap=${options.sourcemap === true ? 'external' : options.sourcemap}`);
  if (options.sourcefile) flags.push(`--sourcefile=${options.sourcefile}`);
  if (options.loader) flags.push(`--loader=${options.loader}`);

  return flags;
}

export interface StreamIn {
  writeToStdin: (data: Uint8Array) => void;
  isSync: boolean;
}

export interface StreamOut {
  readFromStdout: (data: Uint8Array) => void;
  afterClose: () => void;
  service: StreamService;
}

export interface StreamService {
  build(options: types.BuildOptions, isTTY: boolean, callback: (err: Error | null, res: types.BuildResult | null) => void): void;
  transform(input: string, options: types.TransformOptions, isTTY: boolean, callback: (err: Error | null, res: types.TransformResult | null) => void): void;
}

// This can't use any promises in the main execution flow because it must work
// for both sync and async code. There is an exception for plugin code because
// that can't work in sync code anyway.
export function createChannel(options: StreamIn): StreamOut {
  let responseCallbacks = new Map<number, (error: string | null, response: protocol.Value) => void>();
  let pluginCallbacks = new Map<number, (request: protocol.PluginRequest) => Promise<protocol.PluginResponse>>();
  let isClosed = false;
  let nextRequestID = 0;
  let nextPluginKey = 0;

  // Use a long-lived buffer to store stdout data
  let stdout = new Uint8Array(4096);
  let stdoutUsed = 0;
  let readFromStdout = (chunk: Uint8Array) => {
    // Append the chunk to the stdout buffer, growing it as necessary
    let limit = stdoutUsed + chunk.length;
    if (limit > stdout.length) {
      let swap = new Uint8Array(limit * 2);
      swap.set(stdout);
      stdout = swap;
    }
    stdout.set(chunk, stdoutUsed);
    stdoutUsed += chunk.length;

    // Process all complete (i.e. not partial) packets
    let offset = 0;
    while (offset + 4 <= stdoutUsed) {
      let length = protocol.readUInt32LE(stdout, offset);
      if (offset + 4 + length > stdoutUsed) {
        break;
      }
      offset += 4;
      handleIncomingPacket(stdout.slice(offset, offset + length));
      offset += length;
    }
    if (offset > 0) {
      stdout.set(stdout.slice(offset));
      stdoutUsed -= offset;
    }
  };

  let afterClose = () => {
    // When the process is closed, fail all pending requests
    isClosed = true;
    for (let callback of responseCallbacks.values()) {
      callback('The service was stopped', null);
    }
    responseCallbacks.clear();
  };

  let sendRequest = <Req, Res>(value: Req, callback: (error: string | null, response: Res | null) => void): void => {
    if (isClosed) return callback('The service is no longer running', null);
    let id = nextRequestID++;
    responseCallbacks.set(id, callback as any);
    options.writeToStdin(protocol.encodePacket({ id, isRequest: true, value: value as any }));
  };

  let sendResponse = (id: number, value: protocol.Value): void => {
    if (isClosed) throw new Error('The service is no longer running');
    options.writeToStdin(protocol.encodePacket({ id, isRequest: false, value }));
  };

  let handleRequest = async (id: number, request: any) => {
    // Catch exceptions in the code below so they get passed to the caller
    try {
      let command = request.command;
      switch (command) {
        case 'plugin': {
          let pluginRequest: protocol.PluginRequest = request;
          let callback = pluginCallbacks.get(pluginRequest.key);
          let result: protocol.PluginResponse = await callback!(pluginRequest);
          sendResponse(id, result as any);
          break;
        }

        default:
          throw new Error(`Invalid command: ` + command);
      }
    } catch (e) {
      let error = 'Internal error'
      try {
        error = ((e && e.message) || e) + '';
      } catch {
      }
      sendResponse(id, { error });
    }
  };

  let handleIncomingPacket = (bytes: Uint8Array): void => {
    let packet = protocol.decodePacket(bytes) as any;

    if (packet.isRequest) {
      handleRequest(packet.id, packet.value);
    }

    else {
      let callback = responseCallbacks.get(packet.id)!;
      responseCallbacks.delete(packet.id);
      if (packet.value.error) callback(packet.value.error, {});
      else callback(null, packet.value);
    }
  };

  let handlePlugins = (plugins: ((plugin: types.Plugin) => void)[], request: protocol.BuildRequest) => {
    if (options.isSync) throw new Error('Cannot use plugins in synchronous API calls');

    interface LoaderPlugin {
      name: string;
      filter: string;
      matchInternal: boolean;
      callback: (args: types.LoaderArgs) => (types.LoaderResult | null | undefined);
    }

    let loaderPlugins: LoaderPlugin[] = [];

    for (let callback of plugins) {
      let name = '';
      callback({
        setName(value) {
          value += '';
          if (value === '') throw new Error('Name of plugin cannot be empty');
          if (name !== '') throw new Error('Name of plugin cannot be set multiple times');
          name = value;
        },
        addLoader(options, callback) {
          if (name === '') throw new Error('Set the plugin name before adding a loader')
          let filter = options.filter;
          if (!filter) throw new Error(`[${name}] Loader is missing a filter`);
          if (!(filter instanceof RegExp)) throw new Error(`[${name}] Loader filter must be a RegExp object`);
          loaderPlugins.push({
            name,
            filter: filter.source,
            matchInternal: !!options.matchInternal,
            callback,
          });
        },
      });
    }

    let pluginKey = nextPluginKey++;

    request.plugins = loaderPlugins.map(loader => ({
      key: pluginKey,
      name: loader.name,
      filter: loader.filter,
      matchInternal: loader.matchInternal,
    }));

    pluginCallbacks.set(pluginKey, async (request: protocol.PluginRequest): Promise<protocol.PluginResponse> => {
      let plugin = loaderPlugins[request.index];
      let callback = plugin.callback;
      let result = callback({ path: request.path });
      let response: protocol.PluginResponse = {};

      if (result != null) {
        let { contents, loader, errors, warnings } = await result;
        if (contents instanceof Uint8Array) response.contents = contents;
        else if (contents != null) response.contents = protocol.encodeUTF8(contents + '');
        if (loader != null) response.loader = loader + '';
        if (errors != null) response.errors = sanitizeMessages(errors);
        if (warnings != null) response.warnings = sanitizeMessages(warnings);
      }

      return response;
    });

    return () => pluginCallbacks.delete(pluginKey);
  };

  return {
    readFromStdout,
    afterClose,

    service: {
      build(options, isTTY, callback) {
        let flags = flagsForBuildOptions(options, isTTY);
        try {
          let write = options.write !== false;
          let request: protocol.BuildRequest = { command: 'build', flags, write };
          let cleanup = 'plugins' in options && handlePlugins(options.plugins, request);
          sendRequest<protocol.BuildRequest, protocol.BuildResponse>(request, (error, response) => {
            if (cleanup) cleanup();
            if (error) return callback(new Error(error), null);
            let errors = response!.errors;
            let warnings = response!.warnings;
            if (errors.length > 0) return callback(failureErrorWithLog('Build failed', errors, warnings), null);
            let result: types.BuildResult = { warnings };
            if (!write) result.outputFiles = response!.outputFiles;
            callback(null, result);
          });
        } catch (e) {
          let error = ((e && e.message) || e) + '';
          sendRequest({ command: 'error', flags, error }, () => {
            callback(e, null);
          });
        }
      },

      transform(input, options, isTTY, callback) {
        let flags = flagsForTransformOptions(options, isTTY);
        try {
          let request: protocol.TransformRequest = { command: 'transform', flags, input };
          sendRequest<protocol.TransformRequest, protocol.TransformResponse>(request, (error, response) => {
            if (error) return callback(new Error(error), null);
            let errors = response!.errors;
            let warnings = response!.warnings;
            if (errors.length > 0) return callback(failureErrorWithLog('Transform failed', errors, warnings), null);
            callback(null, { warnings, js: response!.js, jsSourceMap: response!.jsSourceMap });
          });
        } catch (e) {
          let error = ((e && e.message) || e) + '';
          sendRequest({ command: 'error', flags, error }, () => {
            callback(e, null);
          });
        }
      },
    },
  };
}

function failureErrorWithLog(text: string, errors: types.Message[], warnings: types.Message[]): Error {
  let limit = 5
  let summary = errors.length < 1 ? '' : ` with ${errors.length} error${errors.length < 2 ? '' : 's'}:` +
    errors.slice(0, limit + 1).map((e, i) => {
      if (i === limit) return '\n...';
      if (!e.location) return `\nerror: ${e.text}`;
      let { file, line, column } = e.location;
      return `\n${file}:${line}:${column}: error: ${e.text}`;
    }).join('');
  let error: any = new Error(`${text}${summary}`);
  error.errors = errors;
  error.warnings = warnings;
  return error;
}

function sanitizeMessages(messages: types.Message[]): types.Message[] {
  let messagesClone: types.Message[] = [];
  for (const message of messages) {
    let location = message.location;
    let locationClone: types.Message['location'] = null;

    if (location != null) {
      let { file, line, column, length, lineText } = location;
      locationClone = {
        file: file != null ? file + '' : '',
        line: +line | 0,
        column: +column | 0,
        length: +length | 0,
        lineText: lineText != null ? lineText + '' : '',
      };
    }

    messagesClone.push({
      text: message.text + '',
      location: locationClone,
    });
  }
  return messagesClone;
}
