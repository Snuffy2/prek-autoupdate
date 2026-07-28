import * as core from "@actions/core";

import { errorMessage, runAction } from "./main.js";

void runAction().catch((error: unknown): void => {
  core.setFailed(errorMessage(error));
});
