{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.zero2ai;
in
{
  options.programs.zero2ai = {
    enable = lib.mkEnableOption "ZERO2AI coding agent";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.zero2ai.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "ZERO2AI package to install system-wide.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];
  };
}
