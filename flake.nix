{
  description = "OpenAPI-generated Tembo MCP server";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {nixpkgs, ...}: let
    systems = ["x86_64-linux" "aarch64-linux"];
    forAllSystems = nixpkgs.lib.genAttrs systems;
  in {
    packages = forAllSystems (system: let
      pkgs = import nixpkgs {inherit system;};
    in rec {
      default = tembo-mcp;
      tembo-mcp = pkgs.buildNpmPackage {
        pname = "tembo-mcp";
        version = "0.2.0";
        src = ./.;
        npmDepsHash = "sha256-3fxJesCrMN080PEmAFDC1A9CcfJdaGzqFzodEKD9V1w=";
        npmBuildScript = "build";
      };
    });
  };
}
