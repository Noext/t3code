import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverPiSkills } from "./PiSkills.ts";

const writeFile = Effect.fn(function* (filePath: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, contents);
});

const skillPath = (path: Path.Path, root: string, name: string) =>
  path.join(root, name, "SKILL.md");

const frontmatter = (fields: ReadonlyArray<string>) =>
  ["---", ...fields, "---", "", "# Body"].join("\n");

it.layer(NodeServices.layer)("discoverPiSkills", (it) => {
  it.effect("discovers user and project skills from Pi's roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-skills-" });
      const home = path.join(tempDir, "home");
      const workspace = path.join(tempDir, "workspace");
      const userSkills = path.join(home, ".pi", "agent", "skills");
      const agentsSkills = path.join(home, ".agents", "skills");

      yield* writeFile(
        skillPath(path, userSkills, "deploy"),
        frontmatter(["name: deploy", "description: Deploy the app."]),
      );
      // A root `.md` file is a skill in a `.pi` skills root.
      yield* writeFile(
        path.join(userSkills, "release.md"),
        frontmatter(["name: release", "description: Cut a release."]),
      );
      // ... but only with a description.
      yield* writeFile(path.join(userSkills, "notes.md"), frontmatter(["name: notes"]));
      yield* writeFile(
        skillPath(path, agentsSkills, "review"),
        frontmatter([
          "name: review",
          "description: Review changes.",
          "disable-model-invocation: true",
        ]),
      );
      // In `.agents/skills` the root file is ignored, a nested one is not.
      yield* writeFile(
        path.join(agentsSkills, "ignored.md"),
        frontmatter(["name: ignored", "description: Root files are ignored."]),
      );
      yield* writeFile(
        path.join(agentsSkills, "grouped", "nested.md"),
        frontmatter(["name: nested", "description: Nested grouping file."]),
      );
      yield* writeFile(
        skillPath(path, path.join(workspace, ".pi", "skills"), "workspace-deploy"),
        frontmatter(["name: workspace-deploy", "description: Deploy this repo."]),
      );
      yield* writeFile(
        skillPath(path, path.join(workspace, ".agents", "skills"), "workspace-review"),
        frontmatter(["name: workspace-review", "description: Review this repo."]),
      );

      const skills = yield* discoverPiSkills(workspace, { ...process.env, HOME: home });

      assert.deepEqual(skills, [
        {
          name: "deploy",
          description: "Deploy the app.",
          path: path.join(userSkills, "deploy", "SKILL.md"),
          scope: "user",
          enabled: true,
        },
        {
          name: "nested",
          description: "Nested grouping file.",
          path: path.join(agentsSkills, "grouped", "nested.md"),
          scope: "user",
          enabled: true,
        },
        {
          name: "release",
          description: "Cut a release.",
          path: path.join(userSkills, "release.md"),
          scope: "user",
          enabled: true,
        },
        {
          name: "review",
          description: "Review changes.",
          path: path.join(agentsSkills, "review", "SKILL.md"),
          scope: "user",
          enabled: true,
          userInvocationOnly: true,
        },
        {
          name: "workspace-deploy",
          description: "Deploy this repo.",
          path: path.join(workspace, ".pi", "skills", "workspace-deploy", "SKILL.md"),
          scope: "project",
          enabled: true,
        },
        {
          name: "workspace-review",
          description: "Review this repo.",
          path: path.join(workspace, ".agents", "skills", "workspace-review", "SKILL.md"),
          scope: "project",
          enabled: true,
        },
      ]);
    }),
  );

  it.effect("prefers the project copy on a name collision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-skills-" });
      const home = path.join(tempDir, "home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeFile(
        skillPath(path, path.join(home, ".pi", "agent", "skills"), "deploy"),
        frontmatter(["name: deploy", "description: User deploy."]),
      );
      yield* writeFile(
        skillPath(path, path.join(workspace, ".pi", "skills"), "deploy"),
        frontmatter(["name: deploy", "description: Project deploy."]),
      );

      const skills = yield* discoverPiSkills(workspace, { ...process.env, HOME: home });

      assert.deepEqual(skills, [
        {
          name: "deploy",
          description: "Project deploy.",
          path: path.join(workspace, ".pi", "skills", "deploy", "SKILL.md"),
          scope: "project",
          enabled: true,
        },
      ]);
    }),
  );

  it.effect("reads the agent directory from PI_CODING_AGENT_DIR", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-skills-" });
      const agentDir = path.join(tempDir, "custom-agent");

      yield* writeFile(
        skillPath(path, path.join(agentDir, "skills"), "custom"),
        frontmatter(["name: custom", "description: Custom agent dir."]),
      );

      const skills = yield* discoverPiSkills(undefined, {
        ...process.env,
        HOME: path.join(tempDir, "home"),
        PI_CODING_AGENT_DIR: agentDir,
      });

      assert.deepEqual(skills, [
        {
          name: "custom",
          description: "Custom agent dir.",
          path: path.join(agentDir, "skills", "custom", "SKILL.md"),
          scope: "user",
          enabled: true,
        },
      ]);
    }),
  );
});
