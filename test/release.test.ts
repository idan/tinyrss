import { expect, test } from "bun:test";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };

const root = join(import.meta.dir, "..");
const yaml = async (file: string) => Bun.YAML.parse(await Bun.file(join(root, file)).text()) as any;
const envNames = (service: any): string[] =>
  (service.environment as string[]).map((e) => e.split("=")[0]!).filter((n) => n.startsWith("TINYRSS_"));

test("the Coolify template pins the image of the current version", async () => {
  // When releasing, bump package.json and coolify/tinyrss.yaml together.
  const template = await yaml("coolify/tinyrss.yaml");
  expect(template.services.tinyrss.image).toBe(`ghcr.io/idan/tinyrss:${pkg.version}`);
});

test("the Coolify template is complete and matches docker-compose.yml", async () => {
  const template = (await yaml("coolify/tinyrss.yaml")).services.tinyrss;
  const compose = (await yaml("docker-compose.yml")).services.tinyrss;
  expect(template.volumes).toEqual(["tinyrss-data:/data"]);
  expect(template.healthcheck.test).toEqual(["CMD", "tinyrss", "healthcheck"]);
  expect(template.environment).toContain("SERVICE_URL_TINYRSS_8080");
  expect(template.environment).toContain("TINYRSS_PASSWORD=${SERVICE_PASSWORD_TINYRSS}");
  expect(envNames(template).sort()).toEqual(envNames(compose).sort());
});
