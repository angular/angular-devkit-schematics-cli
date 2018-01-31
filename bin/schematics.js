#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@angular-devkit/core");
const node_1 = require("@angular-devkit/core/node");
const schematics_1 = require("@angular-devkit/schematics");
const node_2 = require("@angular-devkit/schematics/tasks/node");
const tools_1 = require("@angular-devkit/schematics/tools");
const minimist = require("minimist");
const of_1 = require("rxjs/observable/of");
const operators_1 = require("rxjs/operators");
/**
 * Show usage of the CLI tool, and exit the process.
 */
function usage(exitCode = 0) {
    logger.info(core_1.tags.stripIndent `
    schematics [CollectionName:]SchematicName [options, ...]

    By default, if the collection name is not specified, use the internal collection provided
    by the Schematics CLI.

    Options:
        --debug             Debug mode. This is true by default if the collection is a relative
                            path (in that case, turn off with --debug=false).
        --dry-run           Do not output anything, but instead just show what actions would be
                            performed. Default to true if debug is also true.
        --force             Force overwriting files that would otherwise be an error.
        --list-schematics   List all schematics from the collection, by name.
        --verbose           Show more information.

        --help              Show this message.

    Any additional option is passed to the Schematics depending on
  `);
    process.exit(exitCode);
    throw 0; // The node typing sometimes don't have a never type for process.exit().
}
/**
 * Parse the name of schematic passed in argument, and return a {collection, schematic} named
 * tuple. The user can pass in `collection-name:schematic-name`, and this function will either
 * return `{collection: 'collection-name', schematic: 'schematic-name'}`, or it will error out
 * and show usage.
 *
 * In the case where a collection name isn't part of the argument, the default is to use the
 * schematics package (@schematics/schematics) as the collection.
 *
 * This logic is entirely up to the tooling.
 *
 * @param str The argument to parse.
 * @return {{collection: string, schematic: (string)}}
 */
function parseSchematicName(str) {
    let collection = '@schematics/schematics';
    if (!str || str === null) {
        usage(1);
    }
    let schematic = str;
    if (schematic.indexOf(':') != -1) {
        [collection, schematic] = schematic.split(':', 2);
        if (!schematic) {
            usage(2);
        }
    }
    return { collection, schematic };
}
/** Parse the command line. */
const booleanArgs = ['debug', 'dry-run', 'force', 'help', 'list-schematics', 'verbose'];
const argv = minimist(process.argv.slice(2), {
    boolean: booleanArgs,
    default: {
        'debug': null,
        'dry-run': null,
    },
    '--': true,
});
/** Create the DevKit Logger used through the CLI. */
const logger = node_1.createConsoleLogger(argv['verbose']);
if (argv.help) {
    usage();
}
/** Get the collection an schematic name from the first argument. */
const { collection: collectionName, schematic: schematicName, } = parseSchematicName(argv._.shift() || null);
const isLocalCollection = collectionName.startsWith('.') || collectionName.startsWith('/');
/**
 * Create the SchematicEngine, which is used by the Schematic library as callbacks to load a
 * Collection or a Schematic.
 */
const engineHost = new tools_1.NodeModulesEngineHost();
const engine = new schematics_1.SchematicEngine(engineHost);
// Add support for schemaJson.
const registry = new core_1.schema.CoreSchemaRegistry(schematics_1.formats.standardFormats);
engineHost.registerOptionsTransform(tools_1.validateOptionsWithSchema(registry));
engineHost.registerTaskExecutor(node_2.BuiltinTaskExecutor.NodePackage);
engineHost.registerTaskExecutor(node_2.BuiltinTaskExecutor.RepositoryInitializer);
/**
 * The collection to be used.
 * @type {Collection|any}
 */
const collection = engine.createCollection(collectionName);
if (collection === null) {
    logger.fatal(`Invalid collection name: "${collectionName}".`);
    process.exit(3);
    throw 3; // TypeScript doesn't know that process.exit() never returns.
}
/** If the user wants to list schematics, we simply show all the schematic names. */
if (argv['list-schematics']) {
    logger.info(engine.listSchematicNames(collection).join('\n'));
    process.exit(0);
    throw 0; // TypeScript doesn't know that process.exit() never returns.
}
/** Create the schematic from the collection. */
const schematic = collection.createSchematic(schematicName);
/** Gather the arguments for later use. */
const debug = argv.debug === null ? isLocalCollection : argv.debug;
const dryRun = argv['dry-run'] === null ? debug : argv['dry-run'];
const force = argv['force'];
/** This host is the original Tree created from the current directory. */
const host = of_1.of(new schematics_1.FileSystemTree(new tools_1.FileSystemHost(process.cwd())));
// We need two sinks if we want to output what will happen, and actually do the work.
// Note that fsSink is technically not used if `--dry-run` is passed, but creating the Sink
// does not have any side effect.
const dryRunSink = new schematics_1.DryRunSink(process.cwd(), force);
const fsSink = new schematics_1.FileSystemSink(process.cwd(), force);
// We keep a boolean to tell us whether an error would occur if we were to commit to an
// actual filesystem. In this case we simply show the dry-run, but skip the fsSink commit.
let error = false;
// Indicate to the user when nothing has been done.
let nothingDone = true;
const loggingQueue = [];
// Logs out dry run events.
dryRunSink.reporter.subscribe((event) => {
    nothingDone = false;
    switch (event.kind) {
        case 'error':
            const desc = event.description == 'alreadyExist' ? 'already exists' : 'does not exist.';
            logger.warn(`ERROR! ${event.path} ${desc}.`);
            error = true;
            break;
        case 'update':
            loggingQueue.push(core_1.tags.oneLine `
        ${core_1.terminal.white('UPDATE')} ${event.path} (${event.content.length} bytes)
      `);
            break;
        case 'create':
            loggingQueue.push(core_1.tags.oneLine `
        ${core_1.terminal.green('CREATE')} ${event.path} (${event.content.length} bytes)
      `);
            break;
        case 'delete':
            loggingQueue.push(`${core_1.terminal.yellow('DELETE')} ${event.path}`);
            break;
        case 'rename':
            loggingQueue.push(`${core_1.terminal.blue('RENAME')} ${event.path} => ${event.to}`);
            break;
    }
});
/**
 * Remove every options from argv that we support in schematics itself.
 */
const args = Object.assign({}, argv);
delete args['--'];
for (const key of booleanArgs) {
    delete args[key];
}
/**
 * Add options from `--` to args.
 */
const argv2 = minimist(argv['--']);
for (const key of Object.keys(argv2)) {
    args[key] = argv2[key];
}
delete args._;
/**
 * The main path. Call the schematic with the host. This creates a new Context for the schematic
 * to run in, then call the schematic rule using the input Tree. This returns a new Tree as if
 * the schematic was applied to it.
 *
 * We then optimize this tree. This removes any duplicated actions or actions that would result
 * in a noop (for example, creating then deleting a file). This is not necessary but will greatly
 * improve performance as hitting the file system is costly.
 *
 * Then we proceed to run the dryRun commit. We run this before we then commit to the filesystem
 * (if --dry-run was not passed or an error was detected by dryRun).
 */
schematic.call(args, host, { debug, logger: logger.asApi() })
    .pipe(operators_1.map((tree) => schematics_1.Tree.optimize(tree)), operators_1.concatMap((tree) => {
    return dryRunSink.commit(tree).pipe(operators_1.ignoreElements(), operators_1.concat(of_1.of(tree)));
}), operators_1.concatMap((tree) => {
    if (!error) {
        // Output the logging queue.
        loggingQueue.forEach(log => logger.info(log));
    }
    if (nothingDone) {
        logger.info('Nothing to be done.');
    }
    if (dryRun || error) {
        return of_1.of(tree);
    }
    return fsSink.commit(tree).pipe(operators_1.ignoreElements(), operators_1.concat(of_1.of(tree)));
}), operators_1.concatMap(() => engine.executePostTasks()))
    .subscribe({
    error(err) {
        if (debug) {
            logger.fatal('An error occured:\n' + err.stack);
        }
        else {
            logger.fatal(err.message);
        }
        process.exit(1);
    },
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NoZW1hdGljcy5qcyIsInNvdXJjZVJvb3QiOiIuLyIsInNvdXJjZXMiOlsicGFja2FnZXMvYW5ndWxhcl9kZXZraXQvc2NoZW1hdGljc19jbGkvYmluL3NjaGVtYXRpY3MudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBUUEsK0NBSThCO0FBQzlCLG9EQUFnRTtBQUNoRSwyREFRb0M7QUFDcEMsZ0VBQTRFO0FBQzVFLDREQUkwQztBQUMxQyxxQ0FBcUM7QUFDckMsMkNBQXdEO0FBQ3hELDhDQUt3QjtBQUV4Qjs7R0FFRztBQUNILGVBQWUsUUFBUSxHQUFHLENBQUM7SUFDekIsTUFBTSxDQUFDLElBQUksQ0FBQyxXQUFJLENBQUMsV0FBVyxDQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7R0FrQjNCLENBQUMsQ0FBQztJQUVILE9BQU8sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUM7SUFDdkIsTUFBTSxDQUFDLENBQUMsQ0FBRSx3RUFBd0U7QUFDcEYsQ0FBQztBQUdEOzs7Ozs7Ozs7Ozs7O0dBYUc7QUFDSCw0QkFBNEIsR0FBa0I7SUFDNUMsSUFBSSxVQUFVLEdBQUcsd0JBQXdCLENBQUM7SUFFMUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksR0FBRyxLQUFLLElBQUksQ0FBQyxDQUFDLENBQUM7UUFDekIsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ1gsQ0FBQztJQUVELElBQUksU0FBUyxHQUFXLEdBQWEsQ0FBQztJQUN0QyxFQUFFLENBQUMsQ0FBQyxTQUFTLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUNqQyxDQUFDLFVBQVUsRUFBRSxTQUFTLENBQUMsR0FBRyxTQUFTLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxDQUFDLENBQUMsQ0FBQztRQUVsRCxFQUFFLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUM7WUFDZixLQUFLLENBQUMsQ0FBQyxDQUFDLENB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QUFDLFdBQVcsQ0FBQyxDQUFDLENBQUM7UUFDaEIsTUFBTSxDQUFDLElBQUksQ0FBQyxxQkFBcUIsQ0FBQyxDQUFDO0lBQ3JDLENBQUM7SUFFRCxFQUFFLENBQUMsQ0FBQyxNQUFNLElBQUksS0FBSyxDQUFDLENBQUMsQ0FBQztRQUNwQixNQUFNLENBQUMsT0FBWSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQzVCLENBQUM7SUFFRCxNQUFNLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQzdCLDBCQUFjLEVBQUUsRUFDaEIsa0JBQU0sQ0FBQyxPQUFZLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2hDLENBQUMsQ0FBQyxFQUNGLHFCQUFTLENBQUMsR0FBRyxFQUFFLENBQUMsTUFBTSxDQUFDLGdCQUFnQixFQUFFLENBQUMsQ0FBQztLQUM1QyxTQUFTLENBQUM7SUFDVCxLQUFLLENBQUMsR0FBVTtRQUNkLEVBQUUsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7WUFDVixNQUFNLENBQUMsS0FBSyxDQUFDLHFCQUFxQixHQUFHLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNsRCxDQUFDO1FBQUMsSUFBSSxDQUFDLENBQUM7WUFDTixNQUFNLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUM1QixDQUFDO1FBQ0QsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUNsQixDQUFDO0NBQ0YsQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiIyEvdXNyL2Jpbi9lbnYgbm9kZVxuLyoqXG4gKiBAbGljZW5zZVxuICogQ29weXJpZ2h0IEdvb2dsZSBJbmMuIEFsbCBSaWdodHMgUmVzZXJ2ZWQuXG4gKlxuICogVXNlIG9mIHRoaXMgc291cmNlIGNvZGUgaXMgZ292ZXJuZWQgYnkgYW4gTUlULXN0eWxlIGxpY2Vuc2UgdGhhdCBjYW4gYmVcbiAqIGZvdW5kIGluIHRoZSBMSUNFTlNFIGZpbGUgYXQgaHR0cHM6Ly9hbmd1bGFyLmlvL2xpY2Vuc2VcbiAqL1xuaW1wb3J0IHtcbiAgc2NoZW1hLFxuICB0YWdzLFxuICB0ZXJtaW5hbCxcbn0gZnJvbSAnQGFuZ3VsYXItZGV2a2l0L2NvcmUnO1xuaW1wb3J0IHsgY3JlYXRlQ29uc29sZUxvZ2dlciB9IGZyb20gJ0Bhbmd1bGFyLWRldmtpdC9jb3JlL25vZGUnO1xuaW1wb3J0IHtcbiAgRHJ5UnVuRXZlbnQsXG4gIERyeVJ1blNpbmssXG4gIEZpbGVTeXN0ZW1TaW5rLFxuICBGaWxlU3lzdGVtVHJlZSxcbiAgU2NoZW1hdGljRW5naW5lLFxuICBUcmVlLFxuICBmb3JtYXRzLFxufSBmcm9tICdAYW5ndWxhci1kZXZraXQvc2NoZW1hdGljcyc7XG5pbXBvcnQgeyBCdWlsdGluVGFza0V4ZWN1dG9yIH0gZnJvbSAnQGFuZ3VsYXItZGV2a2l0L3NjaGVtYXRpY3MvdGFza3Mvbm9kZSc7XG5pbXBvcnQge1xuICBGaWxlU3lzdGVtSG9zdCxcbiAgTm9kZU1vZHVsZXNFbmdpbmVIb3N0LFxuICB2YWxpZGF0ZU9wdGlvbnNXaXRoU2NoZW1hLFxufSBmcm9tICdAYW5ndWxhci1kZXZraXQvc2NoZW1hdGljcy90b29scyc7XG5pbXBvcnQgKiBhcyBtaW5pbWlzdCBmcm9tICdtaW5pbWlzdCc7XG5pbXBvcnQgeyBvZiBhcyBvYnNlcnZhYmxlT2YgfSBmcm9tICdyeGpzL29ic2VydmFibGUvb2YnO1xuaW1wb3J0IHtcbiAgY29uY2F0LFxuICBjb25jYXRNYXAsXG4gIGlnbm9yZUVsZW1lbnRzLFxuICBtYXAsXG59IGZyb20gJ3J4anMvb3BlcmF0b3JzJztcblxuLyoqXG4gKiBTaG93IHVzYWdlIG9mIHRoZSBDTEkgdG9vbCwgYW5kIGV4aXQgdGhlIHByb2Nlc3MuXG4gKi9cbmZ1bmN0aW9uIHVzYWdlKGV4aXRDb2RlID0gMCk6IG5ldmVyIHtcbiAgbG9nZ2VyLmluZm8odGFncy5zdHJpcEluZGVudGBcbiAgICBzY2hlbWF0aWNzIFtDb2xsZWN0aW9uTmFtZTpdU2NoZW1hdGljTmFtZSBbb3B0aW9ucywgLi4uXVxuXG4gICAgQnkgZGVmYXVsdCwgaWYgdGhlIGNvbGxlY3Rpb24gbmFtZSBpcyBub3Qgc3BlY2lmaWVkLCB1c2UgdGhlIGludGVybmFsIGNvbGxlY3Rpb24gcHJvdmlkZWRcbiAgICBieSB0aGUgU2NoZW1hdGljcyBDTEkuXG5cbiAgICBPcHRpb25zOlxuICAgICAgICAtLWRlYnVnICAgICAgICAgICAgIERlYnVnIG1vZGUuIFRoaXMgaXMgdHJ1ZSBieSBkZWZhdWx0IGlmIHRoZSBjb2xsZWN0aW9uIGlzIGEgcmVsYXRpdmVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXRoIChpbiB0aGF0IGNhc2UsIHR1cm4gb2ZmIHdpdGggLS1kZWJ1Zz1mYWxzZSkuXG4gICAgICAgIC0tZHJ5LXJ1biAgICAgICAgICAgRG8gbm90IG91dHB1dCBhbnl0aGluZywgYnV0IGluc3RlYWQganVzdCBzaG93IHdoYXQgYWN0aW9ucyB3b3VsZCBiZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBlcmZvcm1lZC4gRGVmYXVsdCB0byB0cnVlIGlmIGRlYnVnIGlzIGFsc28gdHJ1ZS5cbiAgICAgICAgLS1mb3JjZSAgICAgICAgICAgICBGb3JjZSBvdmVyd3JpdGluZyBmaWxlcyB0aGF0IHdvdWxkIG90aGVyd2lzZSBiZSBhbiBlcnJvci5cbiAgICAgICAgLS1saXN0LXNjaGVtYXRpY3MgICBMaXN0IGFsbCBzY2hlbWF0aWNzIGZyb20gdGhlIGNvbGxlY3Rpb24sIGJ5IG5hbWUuXG4gICAgICAgIC0tdmVyYm9zZSAgICAgICAgICAgU2hvdyBtb3JlIGluZm9ybWF0aW9uLlxuXG4gICAgICAgIC0taGVscCAgICAgICAgICAgICAgU2hvdyB0aGlzIG1lc3NhZ2UuXG5cbiAgICBBbnkgYWRkaXRpb25hbCBvcHRpb24gaXMgcGFzc2VkIHRvIHRoZSBTY2hlbWF0aWNzIGRlcGVuZGluZyBvblxuICBgKTtcblxuICBwcm9jZXNzLmV4aXQoZXhpdENvZGUpO1xuICB0aHJvdyAwOyAgLy8gVGhlIG5vZGUgdHlwaW5nIHNvbWV0aW1lcyBkb24ndCBoYXZlIGEgbmV2ZXIgdHlwZSBmb3IgcHJvY2Vzcy5leGl0KCkuXG59XG5cblxuLyoqXG4gKiBQYXJzZSB0aGUgbmFtZSBvZiBzY2hlbWF0aWMgcGFzc2VkIGluIGFyZ3VtZW50LCBhbmQgcmV0dXJuIGEge2NvbGxlY3Rpb24sIHNjaGVtYXRpY30gbmFtZWRcbiAqIHR1cGxlLiBUaGUgdXNlciBjYW4gcGFzcyBpbiBgY29sbGVjdGlvbi1uYW1lOnNjaGVtYXRpYy1uYW1lYCwgYW5kIHRoaXMgZnVuY3Rpb24gd2lsbCBlaXRoZXJcbiAqIHJldHVybiBge2NvbGxlY3Rpb246ICdjb2xsZWN0aW9uLW5hbWUnLCBzY2hlbWF0aWM6ICdzY2hlbWF0aWMtbmFtZSd9YCwgb3IgaXQgd2lsbCBlcnJvciBvdXRcbiAqIGFuZCBzaG93IHVzYWdlLlxuICpcbiAqIEluIHRoZSBjYXNlIHdoZXJlIGEgY29sbGVjdGlvbiBuYW1lIGlzbid0IHBhcnQgb2YgdGhlIGFyZ3VtZW50LCB0aGUgZGVmYXVsdCBpcyB0byB1c2UgdGhlXG4gKiBzY2hlbWF0aWNzIHBhY2thZ2UgKEBzY2hlbWF0aWNzL3NjaGVtYXRpY3MpIGFzIHRoZSBjb2xsZWN0aW9uLlxuICpcbiAqIFRoaXMgbG9naWMgaXMgZW50aXJlbHkgdXAgdG8gdGhlIHRvb2xpbmcuXG4gKlxuICogQHBhcmFtIHN0ciBUaGUgYXJndW1lbnQgdG8gcGFyc2UuXG4gKiBAcmV0dXJuIHt7Y29sbGVjdGlvbjogc3RyaW5nLCBzY2hlbWF0aWM6IChzdHJpbmcpfX1cbiAqL1xuZnVuY3Rpb24gcGFyc2VTY2hlbWF0aWNOYW1lKHN0cjogc3RyaW5nIHwgbnVsbCk6IHsgY29sbGVjdGlvbjogc3RyaW5nLCBzY2hlbWF0aWM6IHN0cmluZyB9IHtcbiAgbGV0IGNvbGxlY3Rpb24gPSAnQHNjaGVtYXRpY3Mvc2NoZW1hdGljcyc7XG5cbiAgaWYgKCFzdHIgfHwgc3RyID09PSBudWxsKSB7XG4gICAgdXNhZ2UoMSk7XG4gIH1cblxuICBsZXQgc2NoZW1hdGljOiBzdHJpbmcgPSBzdHIgYXMgc3RyaW5nO1xuICBpZiAoc2NoZW1hdGljLmluZGV4T2YoJzonKSAhPSAtMSkge1xuICAgIFtjb2xsZWN0aW9uLCBzY2hlbWF0aWNdID0gc2NoZW1hdGljLnNwbGl0KCc6JywgMik7XG5cbiAgICBpZiAoIXNjaGVtYXRpYykge1xuICAgICAgdXNhZ2UoMik7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgY29sbGVjdGlvbiwgc2NoZW1hdGljIH07XG59XG5cblxuLyoqIFBhcnNlIHRoZSBjb21tYW5kIGxpbmUuICovXG5jb25zdCBib29sZWFuQXJncyA9IFsgJ2RlYnVnJywgJ2RyeS1ydW4nLCAnZm9yY2UnLCAnaGVscCcsICdsaXN0LXNjaGVtYXRpY3MnLCAndmVyYm9zZScgXTtcbmNvbnN0IGFyZ3YgPSBtaW5pbWlzdChwcm9jZXNzLmFyZ3Yuc2xpY2UoMiksIHtcbiAgYm9vbGVhbjogYm9vbGVhbkFyZ3MsXG4gIGRlZmF1bHQ6IHtcbiAgICAnZGVidWcnOiBudWxsLFxuICAgICdkcnktcnVuJzogbnVsbCxcbiAgfSxcbiAgJy0tJzogdHJ1ZSxcbn0pO1xuXG4vKiogQ3JlYXRlIHRoZSBEZXZLaXQgTG9nZ2VyIHVzZWQgdGhyb3VnaCB0aGUgQ0xJLiAqL1xuY29uc3QgbG9nZ2VyID0gY3JlYXRlQ29uc29sZUxvZ2dlcihhcmd2Wyd2ZXJib3NlJ10pO1xuXG5pZiAoYXJndi5oZWxwKSB7XG4gIHVzYWdlKCk7XG59XG5cbi8qKiBHZXQgdGhlIGNvbGxlY3Rpb24gYW4gc2NoZW1hdGljIG5hbWUgZnJvbSB0aGUgZmlyc3QgYXJndW1lbnQuICovXG5jb25zdCB7XG4gIGNvbGxlY3Rpb246IGNvbGxlY3Rpb25OYW1lLFxuICBzY2hlbWF0aWM6IHNjaGVtYXRpY05hbWUsXG59ID0gcGFyc2VTY2hlbWF0aWNOYW1lKGFyZ3YuXy5zaGlmdCgpIHx8IG51bGwpO1xuY29uc3QgaXNMb2NhbENvbGxlY3Rpb24gPSBjb2xsZWN0aW9uTmFtZS5zdGFydHNXaXRoKCcuJykgfHwgY29sbGVjdGlvbk5hbWUuc3RhcnRzV2l0aCgnLycpO1xuXG5cbi8qKlxuICogQ3JlYXRlIHRoZSBTY2hlbWF0aWNFbmdpbmUsIHdoaWNoIGlzIHVzZWQgYnkgdGhlIFNjaGVtYXRpYyBsaWJyYXJ5IGFzIGNhbGxiYWNrcyB0byBsb2FkIGFcbiAqIENvbGxlY3Rpb24gb3IgYSBTY2hlbWF0aWMuXG4gKi9cbmNvbnN0IGVuZ2luZUhvc3QgPSBuZXcgTm9kZU1vZHVsZXNFbmdpbmVIb3N0KCk7XG5jb25zdCBlbmdpbmUgPSBuZXcgU2NoZW1hdGljRW5naW5lKGVuZ2luZUhvc3QpO1xuXG5cbi8vIEFkZCBzdXBwb3J0IGZvciBzY2hlbWFKc29uLlxuY29uc3QgcmVnaXN0cnkgPSBuZXcgc2NoZW1hLkNvcmVTY2hlbWFSZWdpc3RyeShmb3JtYXRzLnN0YW5kYXJkRm9ybWF0cyk7XG5lbmdpbmVIb3N0LnJlZ2lzdGVyT3B0aW9uc1RyYW5zZm9ybSh2YWxpZGF0ZU9wdGlvbnNXaXRoU2NoZW1hKHJlZ2lzdHJ5KSk7XG5cbmVuZ2luZUhvc3QucmVnaXN0ZXJUYXNrRXhlY3V0b3IoQnVpbHRpblRhc2tFeGVjdXRvci5Ob2RlUGFja2FnZSk7XG5lbmdpbmVIb3N0LnJlZ2lzdGVyVGFza0V4ZWN1dG9yKEJ1aWx0aW5UYXNrRXhlY3V0b3IuUmVwb3NpdG9yeUluaXRpYWxpemVyKTtcblxuLyoqXG4gKiBUaGUgY29sbGVjdGlvbiB0byBiZSB1c2VkLlxuICogQHR5cGUge0NvbGxlY3Rpb258YW55fVxuICovXG5jb25zdCBjb2xsZWN0aW9uID0gZW5naW5lLmNyZWF0ZUNvbGxlY3Rpb24oY29sbGVjdGlvbk5hbWUpO1xuaWYgKGNvbGxlY3Rpb24gPT09IG51bGwpIHtcbiAgbG9nZ2VyLmZhdGFsKGBJbnZhbGlkIGNvbGxlY3Rpb24gbmFtZTogXCIke2NvbGxlY3Rpb25OYW1lfVwiLmApO1xuICBwcm9jZXNzLmV4aXQoMyk7XG4gIHRocm93IDM7ICAvLyBUeXBlU2NyaXB0IGRvZXNuJ3Qga25vdyB0aGF0IHByb2Nlc3MuZXhpdCgpIG5ldmVyIHJldHVybnMuXG59XG5cblxuLyoqIElmIHRoZSB1c2VyIHdhbnRzIHRvIGxpc3Qgc2NoZW1hdGljcywgd2Ugc2ltcGx5IHNob3cgYWxsIHRoZSBzY2hlbWF0aWMgbmFtZXMuICovXG5pZiAoYXJndlsnbGlzdC1zY2hlbWF0aWNzJ10pIHtcbiAgbG9nZ2VyLmluZm8oZW5naW5lLmxpc3RTY2hlbWF0aWNOYW1lcyhjb2xsZWN0aW9uKS5qb2luKCdcXG4nKSk7XG4gIHByb2Nlc3MuZXhpdCgwKTtcbiAgdGhyb3cgMDsgIC8vIFR5cGVTY3JpcHQgZG9lc24ndCBrbm93IHRoYXQgcHJvY2Vzcy5leGl0KCkgbmV2ZXIgcmV0dXJucy5cbn1cblxuXG4vKiogQ3JlYXRlIHRoZSBzY2hlbWF0aWMgZnJvbSB0aGUgY29sbGVjdGlvbi4gKi9cbmNvbnN0IHNjaGVtYXRpYyA9IGNvbGxlY3Rpb24uY3JlYXRlU2NoZW1hdGljKHNjaGVtYXRpY05hbWUpO1xuXG4vKiogR2F0aGVyIHRoZSBhcmd1bWVudHMgZm9yIGxhdGVyIHVzZS4gKi9cbmNvbnN0IGRlYnVnOiBib29sZWFuID0gYXJndi5kZWJ1ZyA9PT0gbnVsbCA/IGlzTG9jYWxDb2xsZWN0aW9uIDogYXJndi5kZWJ1ZztcbmNvbnN0IGRyeVJ1bjogYm9vbGVhbiA9IGFyZ3ZbJ2RyeS1ydW4nXSA9PT0gbnVsbCA/IGRlYnVnIDogYXJndlsnZHJ5LXJ1biddO1xuY29uc3QgZm9yY2UgPSBhcmd2Wydmb3JjZSddO1xuXG4vKiogVGhpcyBob3N0IGlzIHRoZSBvcmlnaW5hbCBUcmVlIGNyZWF0ZWQgZnJvbSB0aGUgY3VycmVudCBkaXJlY3RvcnkuICovXG5jb25zdCBob3N0ID0gb2JzZXJ2YWJsZU9mKG5ldyBGaWxlU3lzdGVtVHJlZShuZXcgRmlsZVN5c3RlbUhvc3QocHJvY2Vzcy5jd2QoKSkpKTtcblxuLy8gV2UgbmVlZCB0d28gc2lua3MgaWYgd2Ugd2FudCB0byBvdXRwdXQgd2hhdCB3aWxsIGhhcHBlbiwgYW5kIGFjdHVhbGx5IGRvIHRoZSB3b3JrLlxuLy8gTm90ZSB0aGF0IGZzU2luayBpcyB0ZWNobmljYWxseSBub3QgdXNlZCBpZiBgLS1kcnktcnVuYCBpcyBwYXNzZWQsIGJ1dCBjcmVhdGluZyB0aGUgU2lua1xuLy8gZG9lcyBub3QgaGF2ZSBhbnkgc2lkZSBlZmZlY3QuXG5jb25zdCBkcnlSdW5TaW5rID0gbmV3IERyeVJ1blNpbmsocHJvY2Vzcy5jd2QoKSwgZm9yY2UpO1xuY29uc3QgZnNTaW5rID0gbmV3IEZpbGVTeXN0ZW1TaW5rKHByb2Nlc3MuY3dkKCksIGZvcmNlKTtcblxuXG4vLyBXZSBrZWVwIGEgYm9vbGVhbiB0byB0ZWxsIHVzIHdoZXRoZXIgYW4gZXJyb3Igd291bGQgb2NjdXIgaWYgd2Ugd2VyZSB0byBjb21taXQgdG8gYW5cbi8vIGFjdHVhbCBmaWxlc3lzdGVtLiBJbiB0aGlzIGNhc2Ugd2Ugc2ltcGx5IHNob3cgdGhlIGRyeS1ydW4sIGJ1dCBza2lwIHRoZSBmc1NpbmsgY29tbWl0LlxubGV0IGVycm9yID0gZmFsc2U7XG5cbi8vIEluZGljYXRlIHRvIHRoZSB1c2VyIHdoZW4gbm90aGluZyBoYXMgYmVlbiBkb25lLlxubGV0IG5vdGhpbmdEb25lID0gdHJ1ZTtcblxuXG5jb25zdCBsb2dnaW5nUXVldWU6IHN0cmluZ1tdID0gW107XG5cbi8vIExvZ3Mgb3V0IGRyeSBydW4gZXZlbnRzLlxuZHJ5UnVuU2luay5yZXBvcnRlci5zdWJzY3JpYmUoKGV2ZW50OiBEcnlSdW5FdmVudCkgPT4ge1xuICBub3RoaW5nRG9uZSA9IGZhbHNlO1xuXG4gIHN3aXRjaCAoZXZlbnQua2luZCkge1xuICAgIGNhc2UgJ2Vycm9yJzpcbiAgICAgIGNvbnN0IGRlc2MgPSBldmVudC5kZXNjcmlwdGlvbiA9PSAnYWxyZWFkeUV4aXN0JyA/ICdhbHJlYWR5IGV4aXN0cycgOiAnZG9lcyBub3QgZXhpc3QuJztcbiAgICAgIGxvZ2dlci53YXJuKGBFUlJPUiEgJHtldmVudC5wYXRofSAke2Rlc2N9LmApO1xuICAgICAgZXJyb3IgPSB0cnVlO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSAndXBkYXRlJzpcbiAgICAgIGxvZ2dpbmdRdWV1ZS5wdXNoKHRhZ3Mub25lTGluZWBcbiAgICAgICAgJHt0ZXJtaW5hbC53aGl0ZSgnVVBEQVRFJyl9ICR7ZXZlbnQucGF0aH0gKCR7ZXZlbnQuY29udGVudC5sZW5ndGh9IGJ5dGVzKVxuICAgICAgYCk7XG4gICAgICBicmVhaztcbiAgICBjYXNlICdjcmVhdGUnOlxuICAgICAgbG9nZ2luZ1F1ZXVlLnB1c2godGFncy5vbmVMaW5lYFxuICAgICAgICAke3Rlcm1pbmFsLmdyZWVuKCdDUkVBVEUnKX0gJHtldmVudC5wYXRofSAoJHtldmVudC5jb250ZW50Lmxlbmd0aH0gYnl0ZXMpXG4gICAgICBgKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgJ2RlbGV0ZSc6XG4gICAgICBsb2dnaW5nUXVldWUucHVzaChgJHt0ZXJtaW5hbC55ZWxsb3coJ0RFTEVURScpfSAke2V2ZW50LnBhdGh9YCk7XG4gICAgICBicmVhaztcbiAgICBjYXNlICdyZW5hbWUnOlxuICAgICAgbG9nZ2luZ1F1ZXVlLnB1c2goYCR7dGVybWluYWwuYmx1ZSgnUkVOQU1FJyl9ICR7ZXZlbnQucGF0aH0gPT4gJHtldmVudC50b31gKTtcbiAgICAgIGJyZWFrO1xuICB9XG59KTtcblxuXG4vKipcbiAqIFJlbW92ZSBldmVyeSBvcHRpb25zIGZyb20gYXJndiB0aGF0IHdlIHN1cHBvcnQgaW4gc2NoZW1hdGljcyBpdHNlbGYuXG4gKi9cbmNvbnN0IGFyZ3MgPSBPYmplY3QuYXNzaWduKHt9LCBhcmd2KTtcbmRlbGV0ZSBhcmdzWyctLSddO1xuZm9yIChjb25zdCBrZXkgb2YgYm9vbGVhbkFyZ3MpIHtcbiAgZGVsZXRlIGFyZ3Nba2V5XTtcbn1cblxuLyoqXG4gKiBBZGQgb3B0aW9ucyBmcm9tIGAtLWAgdG8gYXJncy5cbiAqL1xuY29uc3QgYXJndjIgPSBtaW5pbWlzdChhcmd2WyctLSddKTtcbmZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKGFyZ3YyKSkge1xuICBhcmdzW2tleV0gPSBhcmd2MltrZXldO1xufVxuZGVsZXRlIGFyZ3MuXztcblxuXG4vKipcbiAqIFRoZSBtYWluIHBhdGguIENhbGwgdGhlIHNjaGVtYXRpYyB3aXRoIHRoZSBob3N0LiBUaGlzIGNyZWF0ZXMgYSBuZXcgQ29udGV4dCBmb3IgdGhlIHNjaGVtYXRpY1xuICogdG8gcnVuIGluLCB0aGVuIGNhbGwgdGhlIHNjaGVtYXRpYyBydWxlIHVzaW5nIHRoZSBpbnB1dCBUcmVlLiBUaGlzIHJldHVybnMgYSBuZXcgVHJlZSBhcyBpZlxuICogdGhlIHNjaGVtYXRpYyB3YXMgYXBwbGllZCB0byBpdC5cbiAqXG4gKiBXZSB0aGVuIG9wdGltaXplIHRoaXMgdHJlZS4gVGhpcyByZW1vdmVzIGFueSBkdXBsaWNhdGVkIGFjdGlvbnMgb3IgYWN0aW9ucyB0aGF0IHdvdWxkIHJlc3VsdFxuICogaW4gYSBub29wIChmb3IgZXhhbXBsZSwgY3JlYXRpbmcgdGhlbiBkZWxldGluZyBhIGZpbGUpLiBUaGlzIGlzIG5vdCBuZWNlc3NhcnkgYnV0IHdpbGwgZ3JlYXRseVxuICogaW1wcm92ZSBwZXJmb3JtYW5jZSBhcyBoaXR0aW5nIHRoZSBmaWxlIHN5c3RlbSBpcyBjb3N0bHkuXG4gKlxuICogVGhlbiB3ZSBwcm9jZWVkIHRvIHJ1biB0aGUgZHJ5UnVuIGNvbW1pdC4gV2UgcnVuIHRoaXMgYmVmb3JlIHdlIHRoZW4gY29tbWl0IHRvIHRoZSBmaWxlc3lzdGVtXG4gKiAoaWYgLS1kcnktcnVuIHdhcyBub3QgcGFzc2VkIG9yIGFuIGVycm9yIHdhcyBkZXRlY3RlZCBieSBkcnlSdW4pLlxuICovXG5zY2hlbWF0aWMuY2FsbChhcmdzLCBob3N0LCB7IGRlYnVnLCBsb2dnZXI6IGxvZ2dlci5hc0FwaSgpIH0pXG4gIC5waXBlKFxuICAgIG1hcCgodHJlZTogVHJlZSkgPT4gVHJlZS5vcHRpbWl6ZSh0cmVlKSksXG4gICAgY29uY2F0TWFwKCh0cmVlOiBUcmVlKSA9PiB7XG4gICAgICByZXR1cm4gZHJ5UnVuU2luay5jb21taXQodHJlZSkucGlwZShcbiAgICAgICAgaWdub3JlRWxlbWVudHMoKSxcbiAgICAgICAgY29uY2F0KG9ic2VydmFibGVPZih0cmVlKSkpO1xuICAgIH0pLFxuICAgIGNvbmNhdE1hcCgodHJlZTogVHJlZSkgPT4ge1xuICAgICAgaWYgKCFlcnJvcikge1xuICAgICAgICAvLyBPdXRwdXQgdGhlIGxvZ2dpbmcgcXVldWUuXG4gICAgICAgIGxvZ2dpbmdRdWV1ZS5mb3JFYWNoKGxvZyA9PiBsb2dnZXIuaW5mbyhsb2cpKTtcbiAgICAgIH1cblxuICAgICAgaWYgKG5vdGhpbmdEb25lKSB7XG4gICAgICAgIGxvZ2dlci5pbmZvKCdOb3RoaW5nIHRvIGJlIGRvbmUuJyk7XG4gICAgICB9XG5cbiAgICAgIGlmIChkcnlSdW4gfHwgZXJyb3IpIHtcbiAgICAgICAgcmV0dXJuIG9ic2VydmFibGVPZih0cmVlKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIGZzU2luay5jb21taXQodHJlZSkucGlwZShcbiAgICAgICAgaWdub3JlRWxlbWVudHMoKSxcbiAgICAgICAgY29uY2F0KG9ic2VydmFibGVPZih0cmVlKSkpO1xuICAgIH0pLFxuICAgIGNvbmNhdE1hcCgoKSA9PiBlbmdpbmUuZXhlY3V0ZVBvc3RUYXNrcygpKSlcbiAgLnN1YnNjcmliZSh7XG4gICAgZXJyb3IoZXJyOiBFcnJvcikge1xuICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgIGxvZ2dlci5mYXRhbCgnQW4gZXJyb3Igb2NjdXJlZDpcXG4nICsgZXJyLnN0YWNrKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGxvZ2dlci5mYXRhbChlcnIubWVzc2FnZSk7XG4gICAgICB9XG4gICAgICBwcm9jZXNzLmV4aXQoMSk7XG4gICAgfSxcbiAgfSk7XG4iXX0=