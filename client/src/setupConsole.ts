import { ChildProcess, spawn } from 'child_process';
import { commands, ExtensionContext, Uri, WebviewView, WebviewViewProvider, WebviewViewResolveContext, window, workspace } from 'vscode';
import { state } from './extension';
import { dirname } from 'path';
import * as treeKill from 'tree-kill';

/** A `processing.*` setting */
function setting<T>(name: string, fallback: T): T {
	return workspace.getConfiguration('processing').get<T>(name, fallback);
}

/** How long to wait for more saves before restarting, so saving several files restarts once */
const restartDelay = 200;

export default function setupConsole(context: ExtensionContext) {
	const sketchProcesses: ChildProcess[] = [];
	// The folder of the sketch that's running, unless it's being exported
	let runningSketch: string | undefined;
	// Saves made by running the sketch itself, which shouldn't restart it again
	let isSavingForRun = false;
	let restartTimer: NodeJS.Timeout | undefined;

	const provider = new ProcessingConsoleViewProvider();

	const register = window.registerWebviewViewProvider('processingConsoleView', provider);

	/** Shows a process's output in the console line by line, while it's the latest run */
	const streamOutput = (proc: ChildProcess) => {
		// Line buffering to avoid fragmenting output across multiple timestamps
		const buffers = { stdout: '', stderr: '' };
		const post = (type: 'stdout' | 'stderr' | 'close', value: string | undefined) => provider.webview?.webview.postMessage({ type, value });

		const receive = (type: 'stdout' | 'stderr', data: Buffer) => {
			if (proc !== sketchProcesses[0]) {
				return;
			}
			const lines = (buffers[type] + data?.toString()).split('\n');
			// All but the last element are complete lines, the last waits for the rest of its line
			buffers[type] = lines.pop()!;
			for (const line of lines) {
				post(type, line + '\n');
			}
		};
		proc.stdout?.on('data', (data) => receive('stdout', data));
		proc.stderr?.on('data', (data) => receive('stderr', data));
		proc.on('close', (code) => {
			// Flush any remaining buffered output
			if (buffers.stdout) {
				post('stdout', buffers.stdout);
			}
			if (buffers.stderr) {
				post('stderr', buffers.stderr);
			}
			post('close', code?.toString());
		});
	};

	const startSketch = commands.registerCommand('processing.sketch.run', async (
		resource: Uri,
		extraArguments: string[],
		options: { preserveFocus?: boolean } = {}
	) => {
		if (setting('autosave', true)) {
			// Save all files before running the sketch
			isSavingForRun = true;
			try {
				await commands.executeCommand('workbench.action.files.saveAll');
			} finally {
				isSavingForRun = false;
			}
		}
		resource ??= window.activeTextEditor?.document.uri as Uri;
		if (!resource) {
			return;
		}
		if (!options.preserveFocus) {
			commands.executeCommand('processingConsoleView.focus');
		}
		commands.executeCommand('processing.sketch.stop');

		const extraArgs = Array.isArray(extraArguments) ? [...extraArguments] : [];
		const isExport = extraArgs.includes('--export');
		const sketch = dirname(resource.fsPath);

		const proc = spawn(
			state.selectedVersion.path,
			['cli', `--sketch=${sketch}`, ...extraArgs, '--run'],
			{
				shell: false,
			}
		);
		streamOutput(proc);
		proc.on('close', () => {
			sketchProcesses.splice(sketchProcesses.indexOf(proc), 1);
			if (!sketchProcesses.length) {
				runningSketch = undefined;
			}
			commands.executeCommand('setContext', 'processing.sketch.running', sketchProcesses.length > 0);
		});
		provider.webview?.show?.(true);
		provider.webview?.webview.postMessage({ type: 'clear' });
		sketchProcesses.unshift(proc);
		runningSketch = isExport ? undefined : sketch;
		commands.executeCommand('setContext', 'processing.sketch.running', true);
	});

	// Restart the running sketch when one of its files is saved
	const restartOnSave = workspace.onDidSaveTextDocument((document) => {
		if (!setting('restartOnSave', false) || isSavingForRun || !runningSketch || !sketchProcesses.length) {
			return;
		}
		if (!/\.(pde|java)$/.test(document.uri.fsPath) || dirname(document.uri.fsPath) !== runningSketch) {
			return;
		}
		clearTimeout(restartTimer);
		restartTimer = setTimeout(() => {
			if (runningSketch && sketchProcesses.length) {
				// Keep typing where you were, the console still shows the new run
				commands.executeCommand('processing.sketch.run', document.uri, [], { preserveFocus: true });
			}
		}, restartDelay);
	});

	const restartSketch = commands.registerCommand('processing.sketch.restart', (resource: Uri) => {
		commands.executeCommand('processing.sketch.run', resource);
	});

	const stopSketch = commands.registerCommand('processing.sketch.stop', () => {
		for (const proc of sketchProcesses) {
			treeKill(proc.pid as number);
		}
	});

	const buildSketch = commands.registerCommand('processing.sketch.export', () => {
		commands.executeCommand('processing.sketch.run', undefined, ['--export']);
	});


	context.subscriptions.push(
		register,
		startSketch,
		restartSketch,
		stopSketch,
		buildSketch,
		restartOnSave,
		{ dispose: () => clearTimeout(restartTimer) }
	);
}

// TODO: Add setting for timestamps
// TODO: Add setting for collapsing similar messages
// TODO: Add option to enable/disable stdout and stderr
class ProcessingConsoleViewProvider implements WebviewViewProvider {
	public webview?: WebviewView;

	public resolveWebviewView(webviewView: WebviewView, context: WebviewViewResolveContext): Thenable<void> | void {
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = `
				<!DOCTYPE html>
				<html>
					<head>
						<style>
							body {
								color: var(--vscode-editor-foreground);
								background-color: var(--vscode-editor-background);
								margin: 0;
								padding: 8px;
								font-family: var(--vscode-editor-font-family);
								font-size: var(--vscode-editor-font-size);
							}

							pre {
								margin: 0;
								white-space: pre-wrap;
								word-break: break-word;
							}

							.console-timestamp {
								color: var(--vscode-descriptionForeground);
							}

							.console-stdout {
								color: var(--vscode-editor-foreground);
							}

							.console-stderr {
								color: var(--vscode-editorError-foreground);
							}

							.console-close {
								color: var(--vscode-descriptionForeground);
							}
						</style>
					</head>
					<body>
						<script>
							window.addEventListener('message', event => {

								const message = event.data; // The JSON data our extension sent

								const isScrolledToBottom = (window.innerHeight + window.scrollY) >= document.body.offsetHeight;
								const createTimestampText = () => {
									const now = new Date();
									const hours = now.getHours().toString().padStart(2, '0');
									const minutes = now.getMinutes().toString().padStart(2, '0');
									const seconds = now.getSeconds().toString().padStart(2, '0');
									return "[" + hours + ":" + minutes + ":" + seconds + "] ";
								};

								const appendConsoleLine = (lineClass, text) => {
									const pre = document.createElement("pre");
									pre.className = lineClass;

									const ts = document.createElement("span");
									ts.className = "console-timestamp";
									const timestampText = createTimestampText();
									const continuationPrefix = " ".repeat(timestampText.length);
									const normalizedText = String(text ?? "").replace(/\\n$/, "");
									ts.textContent = timestampText;
									pre.textContent = normalizedText.replaceAll("\\n", "\\n" + continuationPrefix);

									pre.prepend(ts);
									document.body.appendChild(pre);
								};
								

								switch (message.type) {
									case 'clear':
										document.body.innerHTML = '';
										break;
									case 'stdout':
										appendConsoleLine("console-stdout", message.value);
										break;
									case 'stderr':
										appendConsoleLine("console-stderr", message.value);
										break;
									case 'close':
										appendConsoleLine("console-close", "Process exited with code " + message.value);
										break;
								}

								if (isScrolledToBottom) {
									window.scrollTo(0, document.body.scrollHeight);
								}
							});
						</script>
					</body>
				</html>
				`;
		webviewView.onDidDispose(() => {
			commands.executeCommand("processing.sketch.stop");
		});
		this.webview = webviewView;
	}

}