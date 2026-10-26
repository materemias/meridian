{
  bun,
  callPackage,
  claude-code,
  lib,
  makeWrapper,
  nodejs_22,
  self,
  stdenvNoCC,
  versionCheckHook,
}:
let
  inherit (lib.meta) getExe;
  inherit (lib.sources) cleanSource;
  inherit (lib.strings) escapeShellArgs removePrefix versionOlder;
  inherit (lib.trivial) importJSON;
  inherit (stdenvNoCC) hostPlatform;
  package = importJSON "${self}/package.json";
  # Sonnet 5.5 requires 2.1.284 before nixpkgs has packaged it. Reuse the
  # nixpkgs derivation (patching, wrappers and version check), with Anthropic's
  # immutable release manifest; automatically prefer nixpkgs once it catches up.
  # Source: https://downloads.claude.ai/claude-code-releases/2.1.284/manifest.zst.json
  claudeManifest = importJSON ./claude-code-manifest.json;
  claudeCode =
    if versionOlder claude-code.version claudeManifest.version then
      claude-code.override { manifest = claudeManifest; }
    else
      claude-code;
in
stdenvNoCC.mkDerivation (finalAttrs: {
  inherit (package) version;
  pname = "meridian";

  src = cleanSource self;

  strictDeps = true;

  nativeBuildInputs = [
    bun
    makeWrapper
    nodejs_22
  ];

  buildInputs = [ nodejs_22 ];

  configurePhase = ''
    runHook preConfigure
    cp -R ${finalAttrs.passthru.node_modules}/build/node_modules .
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    bun run build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/meridian
    cp -r dist plugin package.json $out/lib/meridian/
    mkdir -p $out/lib/meridian/docs
    cp docs/configuration.md $out/lib/meridian/docs/
    cp -R ${finalAttrs.passthru.node_modules}/runtime/node_modules $out/lib/meridian/
    chmod -R u+w $out/lib/meridian/node_modules
    node ${./prune-foreign-platforms.mjs} $out/lib/meridian/node_modules ${
      escapeShellArgs [
        hostPlatform.node.platform
        hostPlatform.node.arch
      ]
    }

    makeWrapper ${getExe nodejs_22} $out/bin/${finalAttrs.meta.mainProgram} \
      --add-flags "$out/lib/meridian/dist/cli.js" \
      --set-default MERIDIAN_CLAUDE_PATH ${getExe claudeCode}

    makeWrapper ${getExe nodejs_22} $out/bin/meridian-bookkeeping \
      --add-flags "$out/lib/meridian/dist/session-bookkeeping.js"

    runHook postInstall
  '';

  doInstallCheck = true;

  nativeInstallCheckInputs = [ versionCheckHook ];

  passthru.node_modules = callPackage ./node_modules.nix { inherit (finalAttrs) pname src version; };

  meta = {
    inherit (package) description;
    broken = versionOlder claudeCode.version (
      removePrefix "^" package.dependencies."@anthropic-ai/claude-code"
    );
    homepage = "https://github.com/rynfar/${finalAttrs.pname}";
    license = lib.licenses.mit;
    mainProgram = finalAttrs.pname;
    platforms = lib.platforms.unix;
    sourceProvenance = with lib.sourceTypes; [ fromSource ];
  };
})
