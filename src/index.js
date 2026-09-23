import { inspectRemoteSource } from "./inspection/inspectRemoteSource.js";
import { initializeUrlInput } from "./ui/SourceControls.js";
import { initializeThemeControls } from "./ui/ThemeControls.js";
import { initializeTabNavigation } from "./ui/tabs/index.js";

initializeThemeControls();
initializeUrlInput(inspectRemoteSource);
initializeTabNavigation();
