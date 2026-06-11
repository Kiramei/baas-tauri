// @ts-nocheck
// noinspection JSBitwiseOperatorUsage,DuplicatedCode,ExceptionCaughtLocallyJS,PointlessArithmeticExpressionJS

/*
 * TypeScript ESM wrapper for the Broadway H.264 decoder runtime.
 * The Emscripten-generated body is intentionally kept close to the original JS output.
 */

export interface DecoderInfo {
  [key: string]: any;
}

export interface DecoderOptions {
  /** URL used to fetch avc.wasm. Example: new Decoder({ wasmUrl: new URL("./avc.wasm", import.meta.url).href }) */
  wasmUrl?: string;
  /** Convert decoded YUV420 frames to RGBA. Disabled by default. */
  rgb?: boolean;
  /** Enable Broadway slice decoding mode. Usually not needed for normal playback. */
  sliceMode?: boolean;
  sliceNum?: number;
  sliceCnt?: number;
  /** Worker-side memory reuse option from the original Broadway decoder. */
  reuseMemory?: boolean;
}

export interface DecoderInstance {
  options: DecoderOptions;
  now: () => number;
  onPictureDecoded: (
    buffer: Uint8Array,
    width: number,
    height: number,
    infos?: DecoderInfo[]
  ) => void;
  onDecoderReady: (decoder: DecoderInstance) => void;
  decode: (typedAr: Uint8Array, parInfo?: DecoderInfo, copyDoneFun?: () => void) => void;
  streamBuffer?: Uint8Array;
  pictureBuffers?: Record<number, Uint8Array | Uint32Array>;
  infoAr?: DecoderInfo[];
}

export interface DecoderConstructor {
  nowValue: () => number;

  new (options?: DecoderOptions | string): DecoderInstance;
}

declare let module: any;
declare let process: any;
declare let importScripts: any;
declare let read: any;
declare let readbuffer: any;
declare let scriptArgs: any;
declare let quit: any;
declare let print: any;
declare let printErr: any;
declare let FS: any;

let global;

function initglobal() {
  global = this;
  if (!global) {
    if (typeof window != "undefined") {
      global = window;
    } else if (typeof self != "undefined") {
      global = self;
    }
  }
}

initglobal();

let getModule = function (par_broadwayOnHeadersDecoded, par_broadwayOnPictureDecoded, wasmUrl) {
  /*let ModuleX = {
    'print': function(text) { console.log('stdout: ' + text); },
    'printErr': function(text) { console.log('stderr: ' + text); }
  };*/

  /*

    The reason why this is all packed into one file is that this file can also function as worker.
    you can integrate the file into your build system and provide the original file to be loaded into a worker.

  */

  //let Module = (function(){

  let Module = {};
  let moduleOverrides = {};
  let key;
  for (key in Module) {
    if (Module.hasOwnProperty(key)) {
      moduleOverrides[key] = Module[key];
    }
  }
  Module["arguments"] = [];
  Module["thisProgram"] = "./this.program";
  Module["quit"] = function (status, toThrow) {
    throw toThrow;
  };
  Module["preRun"] = [];
  Module["postRun"] = [];
  if (wasmUrl) {
    Module["locateFile"] = function (fileName) {
      return fileName === "avc.wasm" ? wasmUrl : fileName;
    };
  }
  let ENVIRONMENT_IS_WEB = false;
  let ENVIRONMENT_IS_WORKER = false;
  let ENVIRONMENT_IS_NODE = false;
  let ENVIRONMENT_IS_SHELL = false;
  if (Module["ENVIRONMENT"]) {
    if (Module["ENVIRONMENT"] === "WEB") {
      ENVIRONMENT_IS_WEB = true;
    } else if (Module["ENVIRONMENT"] === "WORKER") {
      ENVIRONMENT_IS_WORKER = true;
    } else if (Module["ENVIRONMENT"] === "NODE") {
      ENVIRONMENT_IS_NODE = true;
    } else if (Module["ENVIRONMENT"] === "SHELL") {
      ENVIRONMENT_IS_SHELL = true;
    } else {
      throw new Error(
        "Module['ENVIRONMENT'] value is not valid. must be one of: WEB|WORKER|NODE|SHELL."
      );
    }
  } else {
    ENVIRONMENT_IS_WEB = typeof window === "object";
    ENVIRONMENT_IS_WORKER = typeof importScripts === "function";
    ENVIRONMENT_IS_NODE =
      typeof process === "object" &&
      typeof null === "function" &&
      !ENVIRONMENT_IS_WEB &&
      !ENVIRONMENT_IS_WORKER;
    ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER;
  }
  if (ENVIRONMENT_IS_NODE) {
    let nodeFS;
    let nodePath;
    Module["read"] = function shell_read(filename, binary) {
      let ret;
      if (!nodeFS) nodeFS = null("fs");
      if (!nodePath) nodePath = null("path");
      filename = nodePath["normalize"](filename);
      ret = nodeFS["readFileSync"](filename);
      return binary ? ret : ret.toString();
    };
    Module["readBinary"] = function readBinary(filename) {
      let ret = Module["read"](filename, true);
      if (!ret.buffer) {
        ret = new Uint8Array(ret);
      }
      assert(ret.buffer);
      return ret;
    };
    if (process["argv"].length > 1) {
      Module["thisProgram"] = process["argv"][1].replace(/\\/g, "/");
    }
    Module["arguments"] = process["argv"].slice(2);
    if (typeof module !== "undefined") {
      module["exports"] = Module;
    }
    process["on"]("uncaughtException", function (ex) {
      if (!(ex instanceof ExitStatus)) {
        throw ex;
      }
    });
    process["on"]("unhandledRejection", function () {
      process["exit"](1);
    });
    Module["inspect"] = function () {
      return "[Emscripten Module object]";
    };
  } else if (ENVIRONMENT_IS_SHELL) {
    if (typeof read != "undefined") {
      Module["read"] = function shell_read(f) {
        return read(f);
      };
    }
    Module["readBinary"] = function readBinary(f) {
      let data;
      if (typeof readbuffer === "function") {
        return new Uint8Array(readbuffer(f));
      }
      data = read(f, "binary");
      assert(typeof data === "object");
      return data;
    };
    if (typeof scriptArgs != "undefined") {
      Module["arguments"] = scriptArgs;
    } else if (typeof arguments != "undefined") {
      Module["arguments"] = arguments;
    }
    if (typeof quit === "function") {
      Module["quit"] = function (status) {
        quit(status);
      };
    }
  } else if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
    Module["read"] = function shell_read(url) {
      let xhr = new XMLHttpRequest();
      xhr.open("GET", url, false);
      xhr.send(null);
      return xhr.responseText;
    };
    if (ENVIRONMENT_IS_WORKER) {
      Module["readBinary"] = function readBinary(url) {
        let xhr = new XMLHttpRequest();
        xhr.open("GET", url, false);
        xhr.responseType = "arraybuffer";
        xhr.send(null);
        return new Uint8Array(xhr.response);
      };
    }
    Module["readAsync"] = function readAsync(url, onload, onerror) {
      let xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.responseType = "arraybuffer";
      xhr.onload = function xhr_onload() {
        if (xhr.status == 200 || (xhr.status == 0 && xhr.response)) {
          onload(xhr.response);
          return;
        }
        onerror();
      };
      xhr.onerror = onerror;
      xhr.send(null);
    };
    Module["setWindowTitle"] = function (title) {
      document.title = title;
    };
  } else {
    throw new Error("not compiled for this environment");
  }
  Module["print"] =
    typeof console !== "undefined"
      ? console.log.bind(console)
      : typeof print !== "undefined"
        ? print
        : null;
  Module["printErr"] =
    typeof printErr !== "undefined"
      ? printErr
      : (typeof console !== "undefined" && console.warn.bind(console)) || Module["print"];
  Module.print = Module["print"];
  Module.printErr = Module["printErr"];
  for (key in moduleOverrides) {
    if (moduleOverrides.hasOwnProperty(key)) {
      Module[key] = moduleOverrides[key];
    }
  }
  let STACK_ALIGN = 16;

  function staticAlloc(size) {
    assert(!staticSealed);
    let ret = STATICTOP;
    STATICTOP = (STATICTOP + size + 15) & -16;
    return ret;
  }

  function alignMemory(size, factor) {
    if (!factor) factor = STACK_ALIGN;
    return Math.ceil(size / factor) * factor;
  }

  // noinspection JSUnusedGlobalSymbols
  const asm2wasmImports = {
    "f64-rem": function (x, y) {
      return x % y;
    },
    debugger: function () {
      debugger;
    },
  };
  new Array(0);
  let GLOBAL_BASE = 1024;
  let ABORT = 0;
  let EXITSTATUS = 0;

  function assert(condition, text) {
    if (!condition) {
      abort("Assertion failed: " + text);
    }
  }
  let UTF8Decoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf8") : undefined;

  function UTF8ArrayToString(u8Array, idx) {
    let endPtr = idx;
    while (u8Array[endPtr]) ++endPtr;
    if (endPtr - idx > 16 && u8Array.subarray && UTF8Decoder) {
      return UTF8Decoder.decode(u8Array.subarray(idx, endPtr));
    } else {
      let u0, u1, u2, u3, u4, u5;
      let str = "";
      while (1) {
        u0 = u8Array[idx++];
        if (!u0) return str;
        if (!(u0 & 128)) {
          str += String.fromCharCode(u0);
          continue;
        }
        u1 = u8Array[idx++] & 63;
        if ((u0 & 224) == 192) {
          str += String.fromCharCode(((u0 & 31) << 6) | u1);
          continue;
        }
        u2 = u8Array[idx++] & 63;
        if ((u0 & 240) == 224) {
          u0 = ((u0 & 15) << 12) | (u1 << 6) | u2;
        } else {
          u3 = u8Array[idx++] & 63;
          if ((u0 & 248) == 240) {
            u0 = ((u0 & 7) << 18) | (u1 << 12) | (u2 << 6) | u3;
          } else {
            u4 = u8Array[idx++] & 63;
            if ((u0 & 252) == 248) {
              u0 = ((u0 & 3) << 24) | (u1 << 18) | (u2 << 12) | (u3 << 6) | u4;
            } else {
              u5 = u8Array[idx++] & 63;
              u0 = ((u0 & 1) << 30) | (u1 << 24) | (u2 << 18) | (u3 << 12) | (u4 << 6) | u5;
            }
          }
        }
        if (u0 < 65536) {
          str += String.fromCharCode(u0);
        } else {
          let ch = u0 - 65536;
          str += String.fromCharCode(55296 | (ch >> 10), 56320 | (ch & 1023));
        }
      }
    }
  }

  typeof TextDecoder !== "undefined" ? new TextDecoder("utf-16le") : undefined;
  let WASM_PAGE_SIZE = 65536;
  let ASMJS_PAGE_SIZE = 16777216;

  function alignUp(x, multiple) {
    if (x % multiple > 0) {
      x += multiple - (x % multiple);
    }
    return x;
  }

  let buffer, HEAP8, HEAPU8, HEAP16, HEAPU16, HEAP32, HEAPU32, HEAPF32, HEAPF64;

  function updateGlobalBuffer(buf) {
    Module["buffer"] = buffer = buf;
  }

  function updateGlobalBufferViews() {
    Module["HEAP8"] = HEAP8 = new Int8Array(buffer);
    Module["HEAP16"] = HEAP16 = new Int16Array(buffer);
    Module["HEAP32"] = HEAP32 = new Int32Array(buffer);
    Module["HEAPU8"] = HEAPU8 = new Uint8Array(buffer);
    Module["HEAPU16"] = HEAPU16 = new Uint16Array(buffer);
    Module["HEAPU32"] = HEAPU32 = new Uint32Array(buffer);
    Module["HEAPF32"] = HEAPF32 = new Float32Array(buffer);
    Module["HEAPF64"] = HEAPF64 = new Float64Array(buffer);
  }

  let STATIC_BASE, STATICTOP, staticSealed;
  let STACK_BASE, STACKTOP, STACK_MAX;
  let DYNAMIC_BASE, DYNAMICTOP_PTR;
  STATIC_BASE = STATICTOP = STACK_BASE = STACKTOP = STACK_MAX = DYNAMIC_BASE = DYNAMICTOP_PTR = 0;
  staticSealed = false;

  function abortOnCannotGrowMemory() {
    abort(
      "Cannot enlarge memory arrays. Either (1) compile with  -s TOTAL_MEMORY=X  with X higher than the current value " +
        TOTAL_MEMORY +
        ", (2) compile with  -s ALLOW_MEMORY_GROWTH=1  which allows increasing the size at runtime, or (3) if you want malloc to return NULL (0) instead of this abort, compile with  -s ABORTING_MALLOC=0 "
    );
  }

  function enlargeMemory() {
    abortOnCannotGrowMemory();
  }

  let TOTAL_STACK = Module["TOTAL_STACK"] || 5242880;
  let TOTAL_MEMORY = Module["TOTAL_MEMORY"] || 52428800;
  if (TOTAL_MEMORY < TOTAL_STACK)
    Module.printErr(
      "TOTAL_MEMORY should be larger than TOTAL_STACK, was " +
        TOTAL_MEMORY +
        "! (TOTAL_STACK=" +
        TOTAL_STACK +
        ")"
    );
  if (Module["buffer"]) {
    buffer = Module["buffer"];
  } else {
    if (typeof WebAssembly === "object" && typeof WebAssembly.Memory === "function") {
      Module["wasmMemory"] = new WebAssembly.Memory({
        initial: TOTAL_MEMORY / WASM_PAGE_SIZE,
        maximum: TOTAL_MEMORY / WASM_PAGE_SIZE,
      });
      buffer = Module["wasmMemory"].buffer;
    } else {
      buffer = new ArrayBuffer(TOTAL_MEMORY);
    }
    Module["buffer"] = buffer;
  }
  updateGlobalBufferViews();

  function getTotalMemory() {
    return TOTAL_MEMORY;
  }

  HEAP32[0] = 1668509029;
  HEAP16[1] = 25459;
  if (HEAPU8[2] !== 115 || HEAPU8[3] !== 99)
    throw "Runtime error: expected the system to be little-endian!";

  function callRuntimeCallbacks(callbacks) {
    while (callbacks.length > 0) {
      let callback = callbacks.shift();
      if (typeof callback == "function") {
        callback();
        continue;
      }
      let func = callback.func;
      if (typeof func === "number") {
        if (callback.arg === undefined) {
          Module["dynCall_v"](func);
        } else {
          Module["dynCall_vi"](func, callback.arg);
        }
      } else {
        func(callback.arg === undefined ? null : callback.arg);
      }
    }
  }

  let __ATPRERUN__ = [];
  let __ATINIT__ = [];
  let __ATMAIN__ = [];
  let __ATEXIT__ = [];
  let __ATPOSTRUN__ = [];
  let runtimeInitialized = false;
  let runtimeExited = false;

  function preRun() {
    if (Module["preRun"]) {
      if (typeof Module["preRun"] == "function") Module["preRun"] = [Module["preRun"]];
      while (Module["preRun"].length) {
        addOnPreRun(Module["preRun"].shift());
      }
    }
    callRuntimeCallbacks(__ATPRERUN__);
  }

  function ensureInitRuntime() {
    if (runtimeInitialized) return;
    runtimeInitialized = true;
    callRuntimeCallbacks(__ATINIT__);
  }

  function preMain() {
    callRuntimeCallbacks(__ATMAIN__);
  }

  function exitRuntime() {
    callRuntimeCallbacks(__ATEXIT__);
    runtimeExited = true;
  }

  function postRun() {
    if (Module["postRun"]) {
      if (typeof Module["postRun"] == "function") Module["postRun"] = [Module["postRun"]];
      while (Module["postRun"].length) {
        addOnPostRun(Module["postRun"].shift());
      }
    }
    callRuntimeCallbacks(__ATPOSTRUN__);
  }

  function addOnPreRun(cb) {
    __ATPRERUN__.unshift(cb);
  }

  function addOnPostRun(cb) {
    __ATPOSTRUN__.unshift(cb);
  }

  let runDependencies = 0;
  let runDependencyWatcher = null;
  let dependenciesFulfilled = null;

  function addRunDependency() {
    runDependencies++;
    if (Module["monitorRunDependencies"]) {
      Module["monitorRunDependencies"](runDependencies);
    }
  }

  function removeRunDependency() {
    runDependencies--;
    if (Module["monitorRunDependencies"]) {
      Module["monitorRunDependencies"](runDependencies);
    }
    if (runDependencies == 0) {
      if (runDependencyWatcher !== null) {
        clearInterval(runDependencyWatcher);
        runDependencyWatcher = null;
      }
      if (dependenciesFulfilled) {
        let callback = dependenciesFulfilled;
        dependenciesFulfilled = null;
        callback();
      }
    }
  }

  Module["preloadedImages"] = {};
  Module["preloadedAudios"] = {};
  let dataURIPrefix = "data:application/octet-stream;base64,";

  function isDataURI(filename) {
    return String.prototype.startsWith
      ? filename.startsWith(dataURIPrefix)
      : filename.indexOf(dataURIPrefix) === 0;
  }

  function integrateWasmJS() {
    let wasmTextFile = "avc.wast";
    let wasmBinaryFile = "avc.wasm";
    let asmjsCodeFile = "avc.temp.asm.js";
    if (typeof Module["locateFile"] === "function") {
      if (!isDataURI(wasmTextFile)) {
        Module["locateFile"](wasmTextFile);
      }
      if (!isDataURI(wasmBinaryFile)) {
        wasmBinaryFile = Module["locateFile"](wasmBinaryFile);
      }
      if (!isDataURI(asmjsCodeFile)) {
        Module["locateFile"](asmjsCodeFile);
      }
    }
    let wasmPageSize = 64 * 1024;
    let info = { global: null, env: null, asm2wasm: asm2wasmImports, parent: Module };
    let exports = null;

    function mergeMemory(newBuffer) {
      let oldBuffer = Module["buffer"];
      if (newBuffer.byteLength < oldBuffer.byteLength) {
        Module["printErr"](
          "the new buffer in mergeMemory is smaller than the previous one. in native wasm, we should grow memory here"
        );
      }
      let oldView = new Int8Array(oldBuffer);
      let newView = new Int8Array(newBuffer);
      newView.set(oldView);
      updateGlobalBuffer(newBuffer);
      updateGlobalBufferViews();
    }

    function fixImports(imports) {
      return imports;
    }

    function getBinary() {
      try {
        if (Module["wasmBinary"]) {
          return new Uint8Array(Module["wasmBinary"]);
        }
        if (Module["readBinary"]) {
          return Module["readBinary"](wasmBinaryFile);
        } else {
          throw "on the web, we need the wasm binary to be preloaded and set on Module['wasmBinary']. emcc.py will do that for you when generating HTML (but not JS)";
        }
      } catch (err) {
        abort(err);
      }
    }

    async function getBinaryPromise() {
      if (
        !Module["wasmBinary"] &&
        (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) &&
        typeof fetch === "function"
      ) {
        try {
          const response = await fetch(wasmBinaryFile, { credentials: "same-origin" });
          if (!response["ok"]) {
            throw "failed to load wasm binary file at '" + wasmBinaryFile + "'";
          }
          return await response["arrayBuffer"]();
        } catch {
          return getBinary();
        }
      }
      return new Promise(function (resolve) {
        resolve(getBinary());
      });
    }

    function doNativeWasm(global, env) {
      if (typeof WebAssembly !== "object") {
        Module["printErr"]("no native wasm support detected");
        return false;
      }
      if (!(Module["wasmMemory"] instanceof WebAssembly.Memory)) {
        Module["printErr"]("no native wasm Memory in use");
        return false;
      }
      env["memory"] = Module["wasmMemory"];
      info["global"] = { NaN: NaN, Infinity: Infinity };
      info["global.Math"] = Math;
      info["env"] = env;

      function receiveInstance(instance) {
        exports = instance.exports;
        if (exports.memory) mergeMemory(exports.memory);
        Module["asm"] = exports;
        Module["usingWasm"] = true;
        removeRunDependency();
      }

      addRunDependency();
      if (Module["instantiateWasm"]) {
        try {
          return Module["instantiateWasm"](info, receiveInstance);
        } catch (e) {
          Module["printErr"]("Module.instantiateWasm callback failed with error: " + e);
          return false;
        }
      }

      function receiveInstantiatedSource(output) {
        receiveInstance(output["instance"]);
      }

      function instantiateArrayBuffer(receiver) {
        getBinaryPromise()
          .then(function (binary) {
            return WebAssembly.instantiate(binary, info);
          })
          .then(receiver)
          .catch(function (reason) {
            Module["printErr"]("failed to asynchronously prepare wasm: " + reason);
            abort(reason);
          });
      }

      if (
        !Module["wasmBinary"] &&
        typeof WebAssembly.instantiateStreaming === "function" &&
        !isDataURI(wasmBinaryFile) &&
        typeof fetch === "function"
      ) {
        WebAssembly.instantiateStreaming(
          fetch(wasmBinaryFile, { credentials: "same-origin" }),
          info
        )
          .then(receiveInstantiatedSource)
          .catch(function (reason) {
            Module["printErr"]("wasm streaming compile failed: " + reason);
            Module["printErr"]("falling back to ArrayBuffer instantiation");
            instantiateArrayBuffer(receiveInstantiatedSource);
          });
      } else {
        instantiateArrayBuffer(receiveInstantiatedSource);
      }
      return {};
    }

    Module["asmPreload"] = Module["asm"];
    let asmjsReallocBuffer = Module["reallocBuffer"];
    let wasmReallocBuffer = function (size) {
      let PAGE_MULTIPLE = Module["usingWasm"] ? WASM_PAGE_SIZE : ASMJS_PAGE_SIZE;
      size = alignUp(size, PAGE_MULTIPLE);
      let old = Module["buffer"];
      let oldSize = old.byteLength;
      if (Module["usingWasm"]) {
        try {
          let result = Module["wasmMemory"].grow((size - oldSize) / wasmPageSize);
          if (result !== (-1 | 0)) {
            return (Module["buffer"] = Module["wasmMemory"].buffer);
          } else {
            return null;
          }
        } catch (e) {
          return null;
        }
      }
    };
    Module["reallocBuffer"] = function (size) {
      if (finalMethod === "asmjs") {
        return asmjsReallocBuffer(size);
      } else {
        return wasmReallocBuffer(size);
      }
    };
    let finalMethod = "";
    Module["asm"] = function (global, env) {
      env = fixImports(env);
      if (!env["table"]) {
        let TABLE_SIZE = Module["wasmTableSize"];
        if (TABLE_SIZE === undefined) TABLE_SIZE = 1024;
        let MAX_TABLE_SIZE = Module["wasmMaxTableSize"];
        if (typeof WebAssembly === "object" && typeof WebAssembly.Table === "function") {
          if (MAX_TABLE_SIZE !== undefined) {
            env["table"] = new WebAssembly.Table({
              initial: TABLE_SIZE,
              maximum: MAX_TABLE_SIZE,
              element: "anyfunc",
            });
          } else {
            env["table"] = new WebAssembly.Table({ initial: TABLE_SIZE, element: "anyfunc" });
          }
        } else {
          env["table"] = new Array(TABLE_SIZE);
        }
        Module["wasmTable"] = env["table"];
      }
      if (!env["memoryBase"]) {
        env["memoryBase"] = Module["STATIC_BASE"];
      }
      if (!env["tableBase"]) {
        env["tableBase"] = 0;
      }
      let exports;
      exports = doNativeWasm(global, env);
      assert(exports, "no binaryen method succeeded.");
      return exports;
    };
  }

  integrateWasmJS();
  STATIC_BASE = GLOBAL_BASE;
  STATICTOP = STATIC_BASE + 9888;
  __ATINIT__.push();
  let STATIC_BUMP = 9888;
  Module["STATIC_BASE"] = STATIC_BASE;
  Module["STATIC_BUMP"] = STATIC_BUMP;
  STATICTOP += 16;
  let SYSCALLS = {
    varargs: 0,
    get: function () {
      SYSCALLS.varargs += 4;
      return HEAP32[(SYSCALLS.varargs - 4) >> 2];
    },
  };

  function ___syscall140(which, varargs) {
    SYSCALLS.varargs = varargs;
    try {
      SYSCALLS.get();
      const stream = SYSCALLS.getStreamFromFD(),
        result = SYSCALLS.get(),
        whence = SYSCALLS.get();
      const offset = SYSCALLS.get();
      FS.llseek(stream, offset, whence);
      HEAP32[result >> 2] = stream.position;
      if (stream.getdents && offset === 0 && whence === 0) stream.getdents = null;
      return 0;
    } catch (e) {
      if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e);
      return -e.errno;
    }
  }

  function ___syscall146(which, varargs) {
    SYSCALLS.varargs = varargs;
    try {
      let stream = SYSCALLS.get(),
        iov = SYSCALLS.get(),
        iovcnt = SYSCALLS.get();
      let ret = 0;
      if (!___syscall146.buffers) {
        ___syscall146.buffers = [null, [], []];
        ___syscall146.printChar = function (stream, curr) {
          let buffer = ___syscall146.buffers[stream];
          assert(buffer);
          if (curr === 0 || curr === 10) {
            (stream === 1 ? Module["print"] : Module["printErr"])(UTF8ArrayToString(buffer, 0));
            buffer.length = 0;
          } else {
            buffer.push(curr);
          }
        };
      }
      for (let i = 0; i < iovcnt; i++) {
        let ptr = HEAP32[(iov + i * 8) >> 2];
        let len = HEAP32[(iov + (i * 8 + 4)) >> 2];
        for (let j = 0; j < len; j++) {
          ___syscall146.printChar(stream, HEAPU8[ptr + j]);
        }
        ret += len;
      }
      return ret;
    } catch (e) {
      if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e);
      return -e.errno;
    }
  }

  function ___syscall54(which, varargs) {
    SYSCALLS.varargs = varargs;
    try {
      return 0;
    } catch (e) {
      if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e);
      return -e.errno;
    }
  }

  function ___syscall6(which, varargs) {
    SYSCALLS.varargs = varargs;
    try {
      let stream = SYSCALLS.getStreamFromFD();
      FS.close(stream);
      return 0;
    } catch (e) {
      if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e);
      return -e.errno;
    }
  }

  function _broadwayOnHeadersDecoded() {
    par_broadwayOnHeadersDecoded();
  }

  Module["_broadwayOnHeadersDecoded"] = _broadwayOnHeadersDecoded;

  function _broadwayOnPictureDecoded($buffer, width, height) {
    par_broadwayOnPictureDecoded($buffer, width, height);
  }

  Module["_broadwayOnPictureDecoded"] = _broadwayOnPictureDecoded;

  function _emscripten_memcpy_big(dest, src, num) {
    HEAPU8.set(HEAPU8.subarray(src, src + num), dest);
    return dest;
  }

  function ___setErrNo(value) {
    if (Module["___errno_location"]) HEAP32[Module["___errno_location"]() >> 2] = value;
    return value;
  }

  DYNAMICTOP_PTR = staticAlloc(4);
  STACK_BASE = STACKTOP = alignMemory(STATICTOP);
  STACK_MAX = STACK_BASE + TOTAL_STACK;
  DYNAMIC_BASE = alignMemory(STACK_MAX);
  HEAP32[DYNAMICTOP_PTR >> 2] = DYNAMIC_BASE;
  staticSealed = true;
  Module["wasmTableSize"] = 10;
  Module["wasmMaxTableSize"] = 10;
  Module.asmGlobalArg = {};
  // noinspection JSUnusedGlobalSymbols
  Module.asmLibraryArg = {
    abort: abort,
    enlargeMemory: enlargeMemory,
    getTotalMemory: getTotalMemory,
    abortOnCannotGrowMemory: abortOnCannotGrowMemory,
    ___setErrNo: ___setErrNo,
    ___syscall140: ___syscall140,
    ___syscall146: ___syscall146,
    ___syscall54: ___syscall54,
    ___syscall6: ___syscall6,
    _broadwayOnHeadersDecoded: _broadwayOnHeadersDecoded,
    _broadwayOnPictureDecoded: _broadwayOnPictureDecoded,
    _emscripten_memcpy_big: _emscripten_memcpy_big,
    DYNAMICTOP_PTR: DYNAMICTOP_PTR,
    STACKTOP: STACKTOP,
  };
  let asm = Module["asm"](Module.asmGlobalArg, Module.asmLibraryArg, buffer);
  Module["asm"] = asm;
  Module["_broadwayCreateStream"] = function () {
    return Module["asm"]["_broadwayCreateStream"].apply(null, arguments);
  };
  Module["_broadwayExit"] = function () {
    return Module["asm"]["_broadwayExit"].apply(null, arguments);
  };
  Module["_broadwayGetMajorVersion"] = function () {
    return Module["asm"]["_broadwayGetMajorVersion"].apply(null, arguments);
  };
  Module["_broadwayGetMinorVersion"] = function () {
    return Module["asm"]["_broadwayGetMinorVersion"].apply(null, arguments);
  };
  Module["_broadwayInit"] = function () {
    return Module["asm"]["_broadwayInit"].apply(null, arguments);
  };
  Module["_broadwayPlayStream"] = function () {
    return Module["asm"]["_broadwayPlayStream"].apply(null, arguments);
  };
  Module["asm"] = asm;

  function ExitStatus(status) {
    this.name = "ExitStatus";
    this.message = "Program terminated with exit(" + status + ")";
    this.status = status;
  }

  ExitStatus.prototype = new Error();
  ExitStatus.prototype.constructor = ExitStatus;
  let initialStackTop;
  dependenciesFulfilled = function runCaller() {
    if (!Module["calledRun"]) run();
    if (!Module["calledRun"]) dependenciesFulfilled = runCaller;
  };

  function run() {
    if (runDependencies > 0) {
      return;
    }
    preRun();
    if (runDependencies > 0) return;
    if (Module["calledRun"]) return;

    function doRun() {
      if (Module["calledRun"]) return;
      Module["calledRun"] = true;
      if (ABORT) return;
      ensureInitRuntime();
      preMain();
      if (Module["onRuntimeInitialized"]) Module["onRuntimeInitialized"]();
      postRun();
    }

    if (Module["setStatus"]) {
      Module["setStatus"]("Running...");
      setTimeout(function () {
        setTimeout(function () {
          Module["setStatus"]("");
        }, 1);
        doRun();
      }, 1);
    } else {
      doRun();
    }
  }

  Module["run"] = run;

  function exit(status, implicit) {
    if (implicit && Module["noExitRuntime"] && status === 0) {
      return;
    }
    if (Module["noExitRuntime"]) {
    } else {
      ABORT = true;
      EXITSTATUS = status;
      STACKTOP = initialStackTop;
      exitRuntime();
      if (Module["onExit"]) Module["onExit"](status);
    }
    if (ENVIRONMENT_IS_NODE) {
      process["exit"](status);
    }
    Module["quit"](status, new ExitStatus(status));
  }

  Module["exit"] = exit;

  function abort(what) {
    if (Module["onAbort"]) {
      Module["onAbort"](what);
    }
    if (what !== undefined) {
      Module.print(what);
      Module.printErr(what);
      what = JSON.stringify(what);
    } else {
      what = "";
    }
    ABORT = true;
    EXITSTATUS = 1;
    throw "abort(" + what + "). Build with -s ASSERTIONS=1 for more info.";
  }

  Module["abort"] = abort;
  if (Module["preInit"]) {
    if (typeof Module["preInit"] == "function") Module["preInit"] = [Module["preInit"]];
    while (Module["preInit"].length > 0) {
      Module["preInit"].pop()();
    }
  }
  Module["noExitRuntime"] = true;
  run();

  //   return Module;
  //})();

  let resultModule;
  if (typeof global !== "undefined") {
    if (global.Module) {
      resultModule = global.Module;
    }
  }
  if (typeof Module != "undefined") {
    resultModule = Module;
  }

  resultModule._broadwayOnHeadersDecoded = par_broadwayOnHeadersDecoded;
  resultModule._broadwayOnPictureDecoded = par_broadwayOnPictureDecoded;

  let moduleIsReady = false;
  let cbFun;
  let moduleReady = function () {
    moduleIsReady = true;
    if (cbFun) {
      cbFun(resultModule);
    }
  };

  resultModule.onRuntimeInitialized = function () {
    moduleReady(resultModule);
  };
  return function (callback) {
    if (moduleIsReady) {
      callback(resultModule);
    } else {
      cbFun = callback;
    }
  };
};
const Decoder = (function () {
  "use strict";

  let nowValue = function () {
    return new Date().getTime();
  };

  if (typeof performance != "undefined") {
    if (performance.now) {
      nowValue = function () {
        return performance.now();
      };
    }
  }

  let Decoder = function (parOptions) {
    if (typeof parOptions === "string") {
      parOptions = { wasmUrl: parOptions };
    }
    this.options = parOptions || {};

    this.now = nowValue;

    let asmInstance;

    let fakeWindow = {};

    let toU8Array;
    let toU32Array;

    let onPicFun = function ($buffer, width, height) {
      let buffer = this.pictureBuffers[$buffer];
      if (!buffer) {
        buffer = this.pictureBuffers[$buffer] = toU8Array($buffer, (width * height * 3) / 2);
      }

      let infos;
      let doInfo = false;
      if (this.infoAr.length) {
        doInfo = true;
        infos = this.infoAr;
      }
      this.infoAr = [];

      if (this.options.rgb) {
        if (!asmInstance) {
          asmInstance = getAsm(width, height);
        }
        asmInstance.inp.set(buffer);
        asmInstance.doit();

        let copyU8 = new Uint8Array(asmInstance.outSize);
        copyU8.set(asmInstance.out);

        if (doInfo) {
          infos[0].finishDecoding = nowValue();
        }

        this.onPictureDecoded(copyU8, width, height);
        return;
      }

      if (doInfo) {
        infos[0].finishDecoding = nowValue();
      }
      this.onPictureDecoded(buffer, width, height);
    }.bind(this);

    let ignore = false;

    if (this.options.sliceMode) {
      onPicFun = function ($buffer, width, height, $sliceInfo) {
        if (ignore) {
          return;
        }
        let buffer = this.pictureBuffers[$buffer];
        if (!buffer) {
          buffer = this.pictureBuffers[$buffer] = toU8Array($buffer, (width * height * 3) / 2);
        }
        let sliceInfo = this.pictureBuffers[$sliceInfo];
        if (!sliceInfo) {
          sliceInfo = this.pictureBuffers[$sliceInfo] = toU32Array($sliceInfo, 18);
        }

        let infos;
        if (this.infoAr.length) {
          infos = this.infoAr;
        }
        this.infoAr = [];

        /*if (this.options.rgb){

      no rgb in slice mode

      };*/

        infos[0].finishDecoding = nowValue();
        let sliceInfoAr = [];
        for (let i = 0; i < 20; ++i) {
          sliceInfoAr.push(sliceInfo[i]);
        }
        infos[0].sliceInfoAr = sliceInfoAr;

        this.onPictureDecoded(buffer, width, height);
      }.bind(this);
    }

    let ModuleCallback = getModule.apply(fakeWindow, [
      function () {},
      onPicFun,
      this.options.wasmUrl,
    ]);

    let MAX_STREAM_BUFFER_LENGTH = 1024 * 1024;

    let instance = this;
    this.onPictureDecoded = function () {};

    this.onDecoderReady = function () {};

    let bufferedCalls = [];
    this.decode = function decode(typedAr, parInfo, copyDoneFun) {
      bufferedCalls.push([typedAr, parInfo, copyDoneFun]);
    };

    ModuleCallback(function (Module) {
      let HEAPU8 = Module.HEAPU8;

      // from old constructor
      Module._broadwayInit();

      /**
       * Creates a typed array from a HEAP8 pointer.
       */
      toU8Array = function (ptr, length) {
        return HEAPU8.subarray(ptr, ptr + length);
      };
      toU32Array = function (ptr, length) {
        //let tmp = HEAPU8.subarray(ptr, ptr + (length * 4));
        return new Uint32Array(HEAPU8.buffer, ptr, length);
      };
      instance.streamBuffer = toU8Array(
        Module._broadwayCreateStream(MAX_STREAM_BUFFER_LENGTH),
        MAX_STREAM_BUFFER_LENGTH
      );
      instance.pictureBuffers = {};
      // collect extra infos that are provided with the nal units
      instance.infoAr = [];

      /**
       * Decodes a stream buffer. This may be one single (unframed) NAL unit without the
       * start code, or a sequence of NAL units with framing start code prefixes. This
       * function overwrites stream buffer allocated by the codec with the supplied buffer.
       */

      let sliceNum = 0;
      if (instance.options.sliceMode) {
        sliceNum = instance.options.sliceNum;

        instance.decode = function decode(typedAr, parInfo, copyDoneFun) {
          instance.infoAr.push(parInfo);
          parInfo.startDecoding = nowValue();
          let nals = parInfo.nals;
          let i;
          if (!nals) {
            nals = [];
            parInfo.nals = nals;
            let l = typedAr.length;
            let foundSomething = false;
            let lastFound = 0;
            let lastStart = 0;
            for (i = 0; i < l; ++i) {
              if (typedAr[i] === 1) {
                if (typedAr[i - 1] === 0 && typedAr[i - 2] === 0) {
                  let startPos = i - 2;
                  if (typedAr[i - 3] === 0) {
                    startPos = i - 3;
                  }
                  // its a nal;
                  if (foundSomething) {
                    nals.push({
                      offset: lastFound,
                      end: startPos,
                      type: typedAr[lastStart] & 31,
                    });
                  }
                  lastFound = startPos;
                  lastStart = startPos + 3;
                  if (typedAr[i - 3] === 0) {
                    lastStart = startPos + 4;
                  }
                  foundSomething = true;
                }
              }
            }
            if (foundSomething) {
              nals.push({
                offset: lastFound,
                end: i,
                type: typedAr[lastStart] & 31,
              });
            }
          }

          let currentSlice = 0;
          let playAr;
          let offset = 0;
          for (i = 0; i < nals.length; ++i) {
            if (nals[i].type === 1 || nals[i].type === 5) {
              if (currentSlice === sliceNum) {
                playAr = typedAr.subarray(nals[i].offset, nals[i].end);
                instance.streamBuffer[offset] = 0;
                offset += 1;
                instance.streamBuffer.set(playAr, offset);
                offset += playAr.length;
              }
              currentSlice += 1;
            } else {
              playAr = typedAr.subarray(nals[i].offset, nals[i].end);
              instance.streamBuffer[offset] = 0;
              offset += 1;
              instance.streamBuffer.set(playAr, offset);
              offset += playAr.length;
              Module._broadwayPlayStream(offset);
              offset = 0;
            }
          }
          copyDoneFun();
          Module._broadwayPlayStream(offset);
        };
      } else {
        instance.decode = function decode(typedAr, parInfo) {
          // console.info("Decoding: " + buffer.length);
          // collect infos
          if (parInfo) {
            instance.infoAr.push(parInfo);
            parInfo.startDecoding = nowValue();
          }

          instance.streamBuffer.set(typedAr);
          Module._broadwayPlayStream(typedAr.length);
        };
      }

      if (bufferedCalls.length) {
        let bi: number;
        for (bi = 0; bi < bufferedCalls.length; ++bi) {
          instance.decode(bufferedCalls[bi][0], bufferedCalls[bi][1], bufferedCalls[bi][2]);
        }
        bufferedCalls = [];
      }

      instance.onDecoderReady(instance);
    });
  };

  Decoder.prototype = {};

  /*

  asm.js implementation of a yuv to rgb convertor
  provided by @soliton4

  based on
  http://www.wordsaretoys.com/2013/10/18/making-yuv-conversion-a-little-faster/

*/

  // factory to create asm.js yuv -> rgb convertor for a given resolution
  let asmInstances = {};
  let getAsm = function (parWidth, parHeight) {
    let idStr = "" + parWidth + "x" + parHeight;
    if (asmInstances[idStr]) {
      return asmInstances[idStr];
    }

    let lumaSize = parWidth * parHeight;
    let chromaSize = (lumaSize | 0) >> 2;

    let inpSize = lumaSize + chromaSize + chromaSize;
    let outSize = parWidth * parHeight * 4;
    let cacheSize = Math.pow(2, 24) * 4;
    let size = inpSize + outSize + cacheSize;

    let chunkSize = Math.pow(2, 24);
    let heapSize = chunkSize;
    while (heapSize < size) {
      heapSize += chunkSize;
    }
    let heap = new ArrayBuffer(heapSize);

    let res = asmFactory(global, {}, heap);
    res.init(parWidth, parHeight);
    asmInstances[idStr] = res;

    res.heap = heap;
    res.out = new Uint8Array(heap, 0, outSize);
    res.inp = new Uint8Array(heap, outSize, inpSize);
    res.outSize = outSize;

    return res;
  };

  function asmFactory(stdlib, foreign, heap) {
    "use asm";

    let imul = stdlib.Math.imul;
    let min = stdlib.Math.min;
    let max = stdlib.Math.max;
    let pow = stdlib.Math.pow;
    new stdlib.Uint8Array(heap);
    new stdlib.Uint32Array(heap);
    let inp = new stdlib.Uint8Array(heap);
    new stdlib.Uint8Array(heap);
    let mem32 = new stdlib.Uint32Array(heap);

    // for double algo
    /*let vt = 1.370705;
  let gt = 0.698001;
  let gt2 = 0.337633;
  let bt = 1.732446;*/

    let width = 0;
    let height = 0;
    let lumaSize = 0;
    let chromaSize = 0;
    let inpSize = 0;
    let outSize = 0;

    let inpStart = 0;
    let outStart = 0;

    let widthFour = 0;

    let cacheStart = 0;

    function init(parWidth, parHeight) {
      parWidth = parWidth | 0;
      parHeight = parHeight | 0;

      let i: number;
      let s: number;

      width = parWidth;
      widthFour = imul(parWidth, 4) | 0;
      height = parHeight;
      lumaSize = imul(width | 0, height | 0) | 0;
      chromaSize = (lumaSize | 0) >> 2;
      outSize = imul(imul(width, height) | 0, 4) | 0;
      inpSize = (lumaSize + chromaSize) | (0 + chromaSize) | 0;

      outStart = 0;
      inpStart = (outStart + outSize) | 0;
      cacheStart = (inpStart + inpSize) | 0;

      // initializing memory (to be on the safe side)
      s = ~~+pow(+2, +24);
      s = imul(s, 4) | 0;

      for (i = 0 | 0; ((i | 0) < (s | 0)) | 0; i = (i + 4) | 0) {
        mem32[((cacheStart + i) | 0) >> 2] = 0;
      }
    }

    function doit() {
      let ystart: number;
      let ustart: number;
      let vstart: number;

      let y = 0;
      let yn = 0;
      let u = 0;
      let v = 0;

      let o = 0;

      let line: number;
      let col = 0;

      let usave = 0;
      let vsave = 0;

      let ostart: number;
      let cacheAdr = 0;

      ostart = outStart | 0;

      ystart = inpStart | 0;
      ustart = (ystart + lumaSize) | 0 | 0;
      vstart = (ustart + chromaSize) | 0;

      for (line = 0; (line | 0) < (height | 0); line = (line + 2) | 0) {
        usave = ustart;
        vsave = vstart;
        for (col = 0; (col | 0) < (width | 0); col = (col + 2) | 0) {
          y = inp[ystart >> 0] | 0;
          yn = inp[((ystart + width) | 0) >> 0] | 0;

          u = inp[ustart >> 0] | 0;
          v = inp[vstart >> 0] | 0;

          cacheAdr = (((((y << 16) | 0) + ((u << 8) | 0)) | 0) + v) | 0;
          o = mem32[((cacheStart + cacheAdr) | 0) >> 2] | 0;
          if (o) {
          } else {
            o = yuv2rgbcalc(y, u, v) | 0;
            mem32[((cacheStart + cacheAdr) | 0) >> 2] = o | 0;
          }
          mem32[ostart >> 2] = o;

          cacheAdr = (((((yn << 16) | 0) + ((u << 8) | 0)) | 0) + v) | 0;
          o = mem32[((cacheStart + cacheAdr) | 0) >> 2] | 0;
          if (o) {
          } else {
            o = yuv2rgbcalc(yn, u, v) | 0;
            mem32[((cacheStart + cacheAdr) | 0) >> 2] = o | 0;
          }
          mem32[((ostart + widthFour) | 0) >> 2] = o;

          //yuv2rgb5(y, u, v, ostart);
          //yuv2rgb5(yn, u, v, (ostart + widthFour)|0);
          ostart = (ostart + 4) | 0;

          // next step only for y. u and v stay the same
          ystart = (ystart + 1) | 0;
          y = inp[ystart >> 0] | 0;
          yn = inp[((ystart + width) | 0) >> 0] | 0;

          //yuv2rgb5(y, u, v, ostart);
          cacheAdr = (((((y << 16) | 0) + ((u << 8) | 0)) | 0) + v) | 0;
          o = mem32[((cacheStart + cacheAdr) | 0) >> 2] | 0;
          if (o) {
          } else {
            o = yuv2rgbcalc(y, u, v) | 0;
            mem32[((cacheStart + cacheAdr) | 0) >> 2] = o | 0;
          }
          mem32[ostart >> 2] = o;

          //yuv2rgb5(yn, u, v, (ostart + widthFour)|0);
          cacheAdr = (((((yn << 16) | 0) + ((u << 8) | 0)) | 0) + v) | 0;
          o = mem32[((cacheStart + cacheAdr) | 0) >> 2] | 0;
          if (o) {
          } else {
            o = yuv2rgbcalc(yn, u, v) | 0;
            mem32[((cacheStart + cacheAdr) | 0) >> 2] = o | 0;
          }
          mem32[((ostart + widthFour) | 0) >> 2] = o;
          ostart = (ostart + 4) | 0;

          //all positions inc 1

          ystart = (ystart + 1) | 0;
          ustart = (ustart + 1) | 0;
          vstart = (vstart + 1) | 0;
        }
        ostart = (ostart + widthFour) | 0;
        ystart = (ystart + width) | 0;
      }
    }

    function yuv2rgbcalc(y, u, v) {
      y = y | 0;
      u = u | 0;
      v = v | 0;

      let r;
      let g;
      let b;

      let o;

      let a0;
      let a1;
      let a2;
      let a3;
      let a4;

      a0 = imul(1192, (y - 16) | 0) | 0;
      a1 = imul(1634, (v - 128) | 0) | 0;
      a2 = imul(832, (v - 128) | 0) | 0;
      a3 = imul(400, (u - 128) | 0) | 0;
      a4 = imul(2066, (u - 128) | 0) | 0;

      r = (((a0 + a1) | 0) >> 10) | 0;
      g = (((((a0 - a2) | 0) - a3) | 0) >> 10) | 0;
      b = (((a0 + a4) | 0) >> 10) | 0;

      if (((r & 255) | 0) != (r | 0) || 0) {
        r = min(255, max(0, r | 0) | 0) | 0;
      }
      if (((g & 255) | 0) != (g | 0) || 0) {
        g = min(255, max(0, g | 0) | 0) | 0;
      }
      if (((b & 255) | 0) != (b | 0) || 0) {
        b = min(255, max(0, b | 0) | 0) | 0;
      }

      o = 255;
      o = (o << 8) | 0;
      o = (o + b) | 0;
      o = (o << 8) | 0;
      o = (o + g) | 0;
      o = (o << 8) | 0;
      o = (o + r) | 0;

      return o | 0;
    }

    return {
      init: init,
      doit: doit,
    };
  }

  /*
  potential worker initialization

*/

  if (typeof self != "undefined") {
    let isWorker = false;
    let decoder;
    let reuseMemory = false;
    let sliceMode = false;
    let sliceNum = 0;
    let sliceCnt = 0;
    let lastSliceNum = 0;
    let sliceInfoAr;
    let lastBuf;
    let awaiting = 0;
    let pile = [];
    let startDecoding;
    let finishDecoding;
    let timeDecoding;

    let memAr = [];
    let getMem = function (length) {
      if (memAr.length) {
        let u = memAr.shift();
        while (u && u.byteLength !== length) {
          u = memAr.shift();
        }
        if (u) {
          return u;
        }
      }
      return new ArrayBuffer(length);
    };

    let copySlice = function (source, target, infoAr, width) {
      let copy16 = function (parBegin, parEnd) {
        let i: number;
        for (i = 0; i < 16; ++i) {
          let begin = parBegin + width * i;
          let end = parEnd + width * i;
          target.set(source.subarray(begin, end), begin);
        }
      };
      let copy8 = function (parBegin, parEnd) {
        let i: number;
        for (i = 0; i < 8; ++i) {
          let begin = parBegin + (width / 2) * i;
          let end = parEnd + (width / 2) * i;
          target.set(source.subarray(begin, end), begin);
        }
      };
      let copyChunk = function (begin, end) {
        target.set(source.subarray(begin, end), begin);
      };

      let begin = infoAr[0];
      let end = infoAr[1];
      if (end > 0) {
        copy16(begin, end);
        copy8(infoAr[2], infoAr[3]);
        copy8(infoAr[4], infoAr[5]);
      }
      begin = infoAr[6];
      end = infoAr[7];
      if (end > 0) {
        copy16(begin, end);
        copy8(infoAr[8], infoAr[9]);
        copy8(infoAr[10], infoAr[11]);
      }

      begin = infoAr[12];
      end = infoAr[15];
      if (end > 0) {
        copyChunk(begin, end);
        copyChunk(infoAr[13], infoAr[16]);
        copyChunk(infoAr[14], infoAr[17]);
      }
    };

    let setSliceCnt = function (parSliceCnt) {
      sliceCnt = parSliceCnt;
      lastSliceNum = sliceCnt - 1;
    };

    self.addEventListener(
      "message",
      function (e) {
        if (isWorker) {
          if (reuseMemory) {
            if (e.data.reuse) {
              memAr.push(e.data.reuse);
            }
          }
          if (e.data.buf) {
            if (sliceMode && awaiting !== 0) {
              pile.push(e.data);
            } else {
              decoder.decode(
                new Uint8Array(e.data.buf, e.data.offset || 0, e.data.length),
                e.data.info,
                function () {
                  if (sliceMode && sliceNum !== lastSliceNum) {
                    postMessage(e.data, [e.data.buf]);
                  }
                }
              );
            }
            return;
          }

          if (e.data.slice) {
            // update ref pic
            let copyStart = nowValue();
            copySlice(
              new Uint8Array(e.data.slice),
              lastBuf,
              e.data.infos[0].sliceInfoAr,
              e.data.width
            );
            // is it the one? then we need to update it
            if (e.data.theOne) {
              copySlice(lastBuf, new Uint8Array(e.data.slice), sliceInfoAr, e.data.width);
              if (timeDecoding > e.data.infos[0].timeDecoding) {
                e.data.infos[0].timeDecoding = timeDecoding;
              }
              e.data.infos[0].timeCopy += nowValue() - copyStart;
            }
            // move on
            postMessage(e.data, [e.data.slice]);

            // next frame in the pipe?
            awaiting -= 1;
            if (awaiting === 0 && pile.length) {
              let data = pile.shift();
              decoder.decode(
                new Uint8Array(data.buf, data.offset || 0, data.length),
                data.info,
                function () {
                  if (sliceMode && sliceNum !== lastSliceNum) {
                    postMessage(data, [data.buf]);
                  }
                }
              );
            }
            return;
          }

          if (e.data.setSliceCnt) {
            setSliceCnt(e.data.sliceCnt);
          }
        } else {
          if (e.data && e.data.type === "Broadway.js - Worker init") {
            isWorker = true;
            decoder = new Decoder(e.data.options);

            if (e.data.options.sliceMode) {
              reuseMemory = true;
              sliceMode = true;
              sliceNum = e.data.options.sliceNum;
              setSliceCnt(e.data.options.sliceCnt);

              decoder.onPictureDecoded = function (buffer, width, height, infos) {
                // buffer needs to be copied because we give up ownership
                let copyU8 = new Uint8Array(getMem(buffer.length));
                copySlice(buffer, copyU8, infos[0].sliceInfoAr, width);

                startDecoding = infos[0].startDecoding;
                finishDecoding = infos[0].finishDecoding;
                timeDecoding = finishDecoding - startDecoding;
                infos[0].timeDecoding = timeDecoding;
                infos[0].timeCopy = 0;

                postMessage(
                  {
                    slice: copyU8.buffer,
                    sliceNum: sliceNum,
                    width: width,
                    height: height,
                    infos: infos,
                  },
                  [copyU8.buffer]
                ); // 2nd parameter is used to indicate transfer of ownership

                awaiting = sliceCnt - 1;

                lastBuf = buffer;
                sliceInfoAr = infos[0].sliceInfoAr;
              };
            } else if (e.data.options.reuseMemory) {
              reuseMemory = true;
              decoder.onPictureDecoded = function (buffer, width, height, infos) {
                // buffer needs to be copied because we give up ownership
                let copyU8 = new Uint8Array(getMem(buffer.length));
                copyU8.set(buffer, 0, buffer.length);

                postMessage(
                  {
                    buf: copyU8.buffer,
                    length: buffer.length,
                    width: width,
                    height: height,
                    infos: infos,
                  },
                  [copyU8.buffer]
                ); // 2nd parameter is used to indicate transfer of ownership
              };
            } else {
              decoder.onPictureDecoded = function (buffer, width, height, infos) {
                if (buffer) {
                  buffer = new Uint8Array(buffer);
                }

                // buffer needs to be copied because we give up ownership
                let copyU8 = new Uint8Array(buffer.length);
                copyU8.set(buffer, 0, buffer.length);

                postMessage(
                  {
                    buf: copyU8.buffer,
                    length: buffer.length,
                    width: width,
                    height: height,
                    infos: infos,
                  },
                  [copyU8.buffer]
                ); // 2nd parameter is used to indicate transfer of ownership
              };
            }
            postMessage({ consoleLog: "broadway worker initialized" });
          }
        }
      },
      false
    );
  }

  Decoder.nowValue = nowValue;

  return Decoder;
})();

export default Decoder as unknown as DecoderConstructor;
