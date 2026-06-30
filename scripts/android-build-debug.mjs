import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import {
  androidRoot,
  commandExists,
  copyDirContents,
  ensureAndroidHome,
  ensureInside,
  ensureJavaHome,
  exe,
  newestNdkRoot,
  ndkPrebuiltRoot,
  output,
  parseArgs,
  prependPath,
  removeInside,
  repoRoot,
  run,
} from "./android-script-utils.mjs";

const args = parseArgs(process.argv.slice(2), {
  boolean: ["skipWebBuild", "release"],
});
const profile = args.profile ?? (args.release ? "release" : "debug");
if (!["debug", "release"].includes(profile)) {
  throw new Error(`Unsupported Android build profile: ${profile}. Expected debug or release.`);
}
const isRelease = profile === "release";
const profileTaskName = isRelease ? "Release" : "Debug";
const cargoProfileDir = isRelease ? "release" : "debug";
const abi = args.abi ?? (isRelease ? "arm64" : "x86_64");
const targets = {
  arm64: {
    rust: "aarch64-linux-android",
    androidAbi: "arm64-v8a",
    gradle: "Arm64",
    ndkLibcxx: "aarch64-linux-android",
    openssl: "linux-aarch64",
    clangPrefix: "aarch64-linux-android",
  },
  arm: {
    rust: "armv7-linux-androideabi",
    androidAbi: "armeabi-v7a",
    gradle: "Arm",
    ndkLibcxx: "arm-linux-androideabi",
    openssl: "linux-armv4",
    clangPrefix: "armv7a-linux-androideabi",
  },
  x86: {
    rust: "i686-linux-android",
    androidAbi: "x86",
    gradle: "X86",
    ndkLibcxx: "i686-linux-android",
    openssl: "linux-elf",
    clangPrefix: "i686-linux-android",
  },
  x86_64: {
    rust: "x86_64-linux-android",
    androidAbi: "x86_64",
    gradle: "X86_64",
    ndkLibcxx: "x86_64-linux-android",
    openssl: "linux-x86_64",
    clangPrefix: "x86_64-linux-android",
  },
};

const target = targets[abi];
if (!target) {
  throw new Error(`Unsupported ABI: ${abi}. Expected one of ${Object.keys(targets).join(", ")}`);
}

ensureJavaHome();
ensureAndroidHome();
const ndkRoot = newestNdkRoot();
const llvmRoot = ndkPrebuiltRoot(ndkRoot);
const llvmBin = path.join(llvmRoot, "bin");
prependPath(llvmBin);

const apiLevel = "24";
const targetCc = path.join(llvmBin, exe("clang")).replaceAll("\\", "/");
const targetCxx = path.join(llvmBin, exe("clang++")).replaceAll("\\", "/");
const targetAr = path.join(llvmBin, exe("llvm-ar")).replaceAll("\\", "/");
const targetRanlib = path.join(llvmBin, exe("llvm-ranlib")).replaceAll("\\", "/");
const targetFlag = `--target=${target.clangPrefix}${apiLevel}`;

for (const suffix of [target.rust, target.rust.replaceAll("-", "_")]) {
  process.env[`CC_${suffix}`] = targetCc;
  process.env[`CXX_${suffix}`] = targetCxx;
  process.env[`AR_${suffix}`] = targetAr;
  process.env[`RANLIB_${suffix}`] = targetRanlib;
  process.env[`CFLAGS_${suffix}`] = targetFlag;
  process.env[`CXXFLAGS_${suffix}`] = targetFlag;
}

function writeAndroidPerlCompat(root) {
  const files = {
    [path.join(root, "Locale", "Maketext", "Simple.pm")]: `package Locale::Maketext::Simple;
use strict;
use warnings;

sub import {
  my ($class, @args) = @_;
  my $caller = caller;
  no strict 'refs';
  *{$caller . "::loc"} = \\&loc;
  *{$caller . "::loc_lang"} = \\&loc_lang;
}

sub loc {
  my ($message, @args) = @_;
  $message =~ s/%([0-9]+)/defined $args[$1 - 1] ? $args[$1 - 1] : ""/ge;
  return $message;
}

sub loc_lang {
  return "C";
}

1;
`,
    [path.join(root, "ExtUtils", "MakeMaker.pm")]: `package ExtUtils::MakeMaker;
use strict;
use warnings;

package MM;
use strict;
use warnings;

sub maybe_command {
  my ($class, $file) = @_;
  return defined $file && -f $file ? $file : undef;
}

1;
`,
    [path.join(root, "Pod", "Usage.pm")]: `package Pod::Usage;
use strict;
use warnings;
use Exporter 'import';

our @EXPORT = qw(pod2usage);
our @EXPORT_OK = qw(pod2usage);

sub pod2usage {
  my (@args) = @_;
  my $exitval = 2;
  if (@args == 1 && ref($args[0]) eq 'HASH') {
    $exitval = $args[0]->{exitval} if exists $args[0]->{exitval};
  }
  exit($exitval);
}

1;
`,
  };
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "ascii");
  }
}

function configurePerl() {
  if (process.platform !== "win32") {
    if (!commandExists("perl")) throw new Error("perl is required to build Android OpenSSL.");
    return;
  }

  const gitUsr = "C:\\Program Files\\Git\\usr";
  const gitPerl = path.join(gitUsr, "bin", "perl.exe");
  if (fs.existsSync(gitPerl)) {
    const gitUsrLink = path.join(repoRoot, "target", "android-git-usr");
    if (!fs.existsSync(gitUsrLink)) {
      fs.mkdirSync(path.dirname(gitUsrLink), { recursive: true });
      fs.symlinkSync(gitUsr, gitUsrLink, "junction");
    }
    const gitPerlBin = path.join(gitUsrLink, "bin");
    prependPath(gitPerlBin);
    const sh = path.join(gitPerlBin, "sh.exe");
    if (fs.existsSync(sh)) process.env.SHELL = sh.replaceAll("\\", "/");
    delete process.env.PERL;
    const compatRoot = path.join(repoRoot, "target", "android-perl-compat");
    writeAndroidPerlCompat(compatRoot);
    const bash = path.join(gitPerlBin, "bash.exe");
    if (fs.existsSync(bash)) {
      const unixCompatRoot = output(bash, ["-lc", `cygpath -u '${compatRoot.replaceAll("'", "'\\''")}'`]);
      process.env.PERL5LIB = process.env.PERL5LIB
        ? `${unixCompatRoot}${path.delimiter}${process.env.PERL5LIB}`
        : unixCompatRoot;
    }
    return;
  }

  const strawberry = "C:\\Strawberry\\perl\\bin";
  if (fs.existsSync(path.join(strawberry, "perl.exe"))) {
    prependPath(strawberry);
    return;
  }
  if (!commandExists("perl")) throw new Error("perl is required to build Android OpenSSL.");
}

async function ensureMake() {
  if (commandExists("make")) return;
  if (process.platform !== "win32") {
    throw new Error("GNU make is required to build Android native dependencies.");
  }

  const toolsRoot = path.join(repoRoot, "target", "android-build-tools");
  const xpackRoot = path.join(toolsRoot, "xpack-windows-build-tools");
  const findMake = () => {
    if (!fs.existsSync(xpackRoot)) return null;
    const stack = [xpackRoot];
    while (stack.length > 0) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        if (entry.isFile() && entry.name.toLowerCase() === "make.exe") return full;
      }
    }
    return null;
  };

  let make = findMake();
  if (!make) {
    const archive = path.join(toolsRoot, "xpack-windows-build-tools.zip");
    const url =
      "https://github.com/xpack-dev-tools/windows-build-tools-xpack/releases/download/v4.4.1-3/xpack-windows-build-tools-4.4.1-3-win32-x64.zip";
    fs.mkdirSync(toolsRoot, { recursive: true });
    if (!fs.existsSync(archive)) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to download Windows build tools: HTTP ${response.status}`);
      fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    }
    fs.rmSync(xpackRoot, { recursive: true, force: true });
    new AdmZip(archive).extractAllTo(xpackRoot, true);
    make = findMake();
  }
  if (!make) throw new Error("GNU make is required to build Android native dependencies.");
  prependPath(path.dirname(make));
}

function findOpenSslSrcCrate() {
  const cargoHome = process.env.CARGO_HOME ?? path.join(os.homedir(), ".cargo");
  const registrySrc = path.join(cargoHome, "registry", "src");
  if (!fs.existsSync(registrySrc)) return null;
  const matches = [];
  for (const registry of fs.readdirSync(registrySrc)) {
    const registryPath = path.join(registrySrc, registry);
    if (!fs.statSync(registryPath).isDirectory()) continue;
    for (const entry of fs.readdirSync(registryPath, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("openssl-src-")) {
        matches.push(path.join(registryPath, entry.name));
      }
    }
  }
  matches.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
  return matches[0] ?? null;
}

function buildAndroidOpenSsl() {
  const installRoot = path.join(repoRoot, "target", "android-openssl", target.rust);
  const cryptoLib = path.join(installRoot, "lib", "libcrypto.a");
  const sslLib = path.join(installRoot, "lib", "libssl.a");
  if (fs.existsSync(cryptoLib) && fs.existsSync(sslLib)) return installRoot;

  run("cargo", ["fetch", "--manifest-path", path.join(repoRoot, "src-tauri", "Cargo.toml"), "--target", target.rust], {
    errorMessage: "Failed to fetch Rust dependencies before building Android OpenSSL.",
  });

  const crateRoot = findOpenSslSrcCrate();
  if (!crateRoot) throw new Error("Unable to locate openssl-src crate after cargo fetch.");
  const opensslSource = path.join(crateRoot, "openssl");
  if (!fs.existsSync(path.join(opensslSource, "Configure"))) {
    throw new Error("Unable to locate OpenSSL source in openssl-src crate.");
  }

  const buildRoot = path.join(repoRoot, "target", "android-openssl-build", target.rust);
  fs.rmSync(buildRoot, { recursive: true, force: true });
  fs.mkdirSync(buildRoot, { recursive: true });
  for (const entry of fs.readdirSync(opensslSource)) {
    fs.cpSync(path.join(opensslSource, entry), path.join(buildRoot, entry), {
      recursive: true,
      force: true,
    });
  }

  const env = {
    ...process.env,
    CC: targetCc,
    CXX: targetCxx,
    AR: targetAr,
    RANLIB: targetRanlib,
    CFLAGS: targetFlag,
    PERL: "perl",
  };
  run(
    "perl",
    [
      "Configure",
      target.openssl,
      "no-asm",
      "no-shared",
      "no-module",
      "no-tests",
      "no-comp",
      "no-zlib",
      "no-zlib-dynamic",
      "no-ssl3",
      "no-md2",
      "no-rc5",
      "no-weak-ssl-ciphers",
      "no-camellia",
      "no-idea",
      "no-seed",
      "no-stdio",
      `--prefix=${installRoot.replaceAll("\\", "/")}`,
      "--openssldir=/usr/local/ssl",
      "--libdir=lib",
    ],
    { cwd: buildRoot, env, errorMessage: "OpenSSL Configure failed." },
  );
  run("make", ["build_libs", "install_dev"], {
    cwd: buildRoot,
    env,
    errorMessage: "OpenSSL build failed.",
  });
  if (!fs.existsSync(cryptoLib) || !fs.existsSync(sslLib)) {
    throw new Error("Android OpenSSL build did not produce expected static libraries.");
  }
  return installRoot;
}

configurePerl();
await ensureMake();

if (!args.skipWebBuild) {
  run("bun", ["run", "build:tauri:android"], {
    errorMessage: "Frontend Android build failed.",
  });
} else {
  run("bun", ["scripts/prepare-android-runtime.mjs"], {
    errorMessage: "Android runtime preparation failed.",
  });
}

const webDist = path.join(repoRoot, "dist");
if (!fs.existsSync(path.join(webDist, "index.html"))) {
  throw new Error(`Missing frontend dist. Run without --skip-web-build at least once: ${webDist}`);
}

const androidAssets = path.join(androidRoot, "app", "src", "main", "assets");
removeInside(repoRoot, androidAssets, "Android assets");
copyDirContents(webDist, androidAssets);

const jniRoot = path.join(androidRoot, "app", "src", "main", "jniLibs");
removeInside(repoRoot, jniRoot, "JNI libraries");

const opensslRoot = buildAndroidOpenSsl();
process.env.OPENSSL_NO_VENDOR = "1";
process.env.OPENSSL_STATIC = "1";
process.env.OPENSSL_DIR = opensslRoot;
process.env[`${target.rust.toUpperCase().replaceAll("-", "_")}_OPENSSL_DIR`] = opensslRoot;

run(
  "cargo",
  [
    "build",
    "--package",
    "baas-tauri",
    "--manifest-path",
    path.join("src-tauri", "Cargo.toml"),
    "--target",
    target.rust,
    "--features",
    "tauri/custom-protocol",
    ...(isRelease ? ["--release"] : []),
  ],
  { errorMessage: `Rust Android build failed for ${target.rust}.` },
);

const sourceLib = path.join(repoRoot, "target", target.rust, cargoProfileDir, "libbaas_tauri_lib.so");
if (!fs.existsSync(sourceLib)) throw new Error(`Missing Rust Android library: ${sourceLib}`);
const destinationDir = path.join(jniRoot, target.androidAbi);
fs.mkdirSync(destinationDir, { recursive: true });
fs.copyFileSync(sourceLib, path.join(destinationDir, "libbaas_tauri_lib.so"));

const libcxx = path.join(
  llvmRoot,
  "sysroot",
  "usr",
  "lib",
  target.ndkLibcxx,
  "libc++_shared.so",
);
if (!fs.existsSync(libcxx)) throw new Error(`Missing Android libc++ runtime: ${libcxx}`);
fs.copyFileSync(libcxx, path.join(destinationDir, "libc++_shared.so"));
ensureInside(repoRoot, destinationDir, "JNI destination");

const gradlew = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
run(gradlew, [`:app:assemble${target.gradle}${profileTaskName}`, "-x", `rustBuild${target.gradle}${profileTaskName}`], {
  cwd: androidRoot,
  errorMessage: "Gradle Android build failed.",
});
