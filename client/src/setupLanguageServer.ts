import { workspace } from 'vscode';
import { LanguageClientOptions } from 'vscode-languageclient';
import { Executable, LanguageClient } from 'vscode-languageclient/node';
import { state } from './extension';
import { provideApiCompletions, resolveApiCompletion } from './setupProcessingApi';

export function setupLanguageServer() {
	// TODO: Listen for version changes and restart the server

	const serverOptions: Executable = {
		command: state.selectedVersion.path,
		args: ["lsp"]
	};

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'Processing' }],
		synchronize: {
			// Notify the server about file changes to '.clientrc files contained in the workspace
			fileEvents: workspace.createFileSystemWatcher('**/*.{pde,java}')
		},
		middleware: {
			// Adds the documented Processing API to the server's completions
			provideCompletionItem: provideApiCompletions,
			resolveCompletionItem: resolveApiCompletion
		}
	};

	// Create the language client and start the client.
	state.client = new LanguageClient(
		'processingLanguageServer',
		'Processing Language Server',
		serverOptions,
		clientOptions
	);

	state.client.error = function (e) {
		console.log(e);
	};

	// Start the client. This will also launch the server
	state.client.start();
}
