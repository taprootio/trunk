import { publishDocs } from "./publish.js";
import {
  PUBLISHER_VERSION,
  PUBLISH_KEY_ENVIRONMENT_VARIABLE,
} from "./constants.js";
import { asPublisherError, PublisherError } from "./errors.js";
import {
  failureResult,
  humanFailure,
  serializeResult,
  writeGithubActionsOutput,
} from "./output.js";

const HELP = `Usage: taproot docs publish [--config <path>] [--quiet] [--require-github-main-head]

Publishes one exact Taproot Docs artifact through validation, staging, and
atomic production promotion. The site-scoped credential is read only from
${PUBLISH_KEY_ENVIRONMENT_VARIABLE}.

Options:
  --config <path>  Use an explicit publisher config instead of parent discovery.
  --quiet          Suppress human progress; JSON output is unchanged.
  --require-github-main-head  Stage only if this GitHub main push is still current.
  --help           Show this help.
  --version        Show the package version.
`;

function parseArguments(arguments_) {
  if (
    (arguments_.length === 1 && arguments_[0] === "--help")
    || (arguments_.length === 3 && arguments_[0] === "docs" && arguments_[1] === "publish" && arguments_[2] === "--help")
  ) return { mode: "help" };
  if (
    (arguments_.length === 1 && arguments_[0] === "--version")
    || (arguments_.length === 3 && arguments_[0] === "docs" && arguments_[1] === "publish" && arguments_[2] === "--version")
  ) return { mode: "version" };
  if (arguments_[0] !== "docs" || arguments_[1] !== "publish") {
    throw new PublisherError("cli.usage", "Expected 'taproot docs publish'.", { exitCode: 2 });
  }
  let configPath;
  let quiet = false;
  let requireGitHubMainHead = false;
  for (let index = 2; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--require-github-main-head") {
      if (requireGitHubMainHead) throw new PublisherError("cli.duplicate_option", "--require-github-main-head may be supplied only once.", { exitCode: 2 });
      requireGitHubMainHead = true;
      continue;
    }
    if (argument === "--quiet") {
      if (quiet) throw new PublisherError("cli.duplicate_option", "--quiet may be supplied only once.", { exitCode: 2 });
      quiet = true;
      continue;
    }
    if (argument === "--config") {
      const candidate = arguments_[index + 1];
      if (
        configPath !== undefined
        || typeof candidate !== "string"
        || candidate.length === 0
        || Buffer.byteLength(candidate, "utf8") > 4_096
        || /[\u0000-\u001f\u007f]/u.test(candidate)
        || candidate.startsWith("--")
      ) {
        throw new PublisherError("cli.config_option", "--config requires exactly one path.", { exitCode: 2 });
      }
      configPath = candidate;
      index += 1;
      continue;
    }
    throw new PublisherError("cli.unknown_option", "The command contains an unknown option.", { exitCode: 2 });
  }
  return { mode: "publish", configPath, quiet, requireGitHubMainHead };
}

export async function runCli({
  arguments_ = process.argv.slice(2),
  environment = process.env,
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  publish = publishDocs,
} = {}) {
  let parsed;
  try {
    parsed = parseArguments(arguments_);
    if (parsed.mode === "help") {
      stdout.write(HELP);
      return 0;
    }
    if (parsed.mode === "version") {
      stdout.write(`${PUBLISHER_VERSION}\n`);
      return 0;
    }
    const result = await publish({
      cwd,
      configPath: parsed.configPath,
      environment,
      quiet: parsed.quiet,
      requireGitHubMainHead: parsed.requireGitHubMainHead,
      onProgress: (message) => stderr.write(`${message}\n`),
    });
    if (environment.GITHUB_OUTPUT) await writeGithubActionsOutput(environment.GITHUB_OUTPUT, result);
    stdout.write(`${serializeResult(result)}\n`);
    return 0;
  } catch (unknownError) {
    const error = asPublisherError(unknownError);
    const result = failureResult(error);
    stdout.write(`${serializeResult(result)}\n`);
    stderr.write(`${humanFailure(error)}\n`);
    if (environment.GITHUB_OUTPUT) {
      try {
        await writeGithubActionsOutput(environment.GITHUB_OUTPUT, result);
      } catch (outputError) {
        stderr.write(`${humanFailure(asPublisherError(outputError))}\n`);
      }
    }
    return error.exitCode;
  }
}
