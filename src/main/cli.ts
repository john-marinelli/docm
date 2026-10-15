import { Command } from 'commander';

export type CliRequest =
  | { mode: 'preview'; sourcePath: string; configPath?: string }
  | { mode: 'render'; sourcePath: string; configPath?: string; outputPath?: string };

export function parseCliArgs(argv: string[]): CliRequest {
  let request: CliRequest | undefined;
  const command = new Command('docm')
    .description('Render Markdown to PDF with an offline desktop live preview')
    .version('0.1.0')
    .argument('[filename]', 'Markdown document to preview')
    .option('--config <file>', 'additional TOML theme')
    .allowExcessArguments(false)
    .configureOutput({ writeOut: text => process.stderr.write(text), writeErr: text => process.stderr.write(text) })
    .exitOverride(error => { if (error.exitCode !== 0) error.exitCode = 2; throw error; })
    .action((filename: string | undefined, options: { config?: string }) => {
      if (!filename) {
        command.outputHelp();
        return command.error('A Markdown filename is required', { exitCode: 2, code: 'docm.missingFilename' });
      }
      request = { mode: 'preview', sourcePath: filename, ...(options.config !== undefined ? { configPath: options.config } : {}) };
    });

  // Commander dispatches subcommands even after `--`. Do not register `r` when
  // the first positional argument is explicitly a literal filename.
  let literalFilename = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === '--') { literalFilename = true; break; }
    if (argument === '--config') { index++; continue; }
    if (!argument.startsWith('-')) break;
  }
  if (!literalFilename) {
    command.command('r')
      .description('Render a PDF without opening a preview window')
      .argument('<filename>', 'Markdown document')
      .option('-o, --output <path>', 'PDF destination, or - for stdout')
      .option('--config <file>', 'additional TOML theme')
      .allowExcessArguments(false)
      .action((filename: string, _options: unknown, render: Command) => {
        const options = render.optsWithGlobals<{ output?: string; config?: string }>();
        request = { mode: 'render', sourcePath: filename, ...(options.config !== undefined ? { configPath: options.config } : {}), ...(options.output !== undefined ? { outputPath: options.output } : {}) };
      });
  }
  command.addHelpText('after', '\nUse docm -- r to preview a file literally named r; use -- before dash-prefixed filenames.');
  command.parse(argv, { from: 'user' });
  if (!request) throw new Error('CLI parsing completed without a request');
  return request;
}
