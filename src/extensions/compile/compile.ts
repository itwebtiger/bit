import path from 'path';
import { Workspace } from '../workspace';
import ConsumerComponent from '../../consumer/component';
import { BitId } from '../../bit-id';
import { ResolvedComponent } from '../workspace/resolved-component';
import buildComponent from '../../consumer/component-ops/build-component';
import { Component } from '../component';
import { ComponentCapsule } from '../capsule/component-capsule';
import DataToPersist from '../../consumer/component/sources/data-to-persist';
import { Scripts } from '../scripts';
import { IdsAndScripts } from '../scripts/ids-and-scripts';
import { Scope } from '../scope';

export type ComponentAndCapsule = {
  consumerComponent: ConsumerComponent;
  component: Component;
  capsule: ComponentCapsule;
};

type ReportResults = {
  component: ResolvedComponent;
  result: { dir: string }[] | null;
  started: boolean;
};

type buildHookResult = { id: BitId; dists?: Array<{ path: string; content: string }> };

export class Compile {
  constructor(private workspace: Workspace, private scripts: Scripts, private scope: Scope) {
    this.workspace = workspace;
    this.scripts = scripts;
    this.scope = scope;

    const func = this.compileDuringBuild.bind(this);
    this.scope.onBuild?.push(func);
  }

  async compileDuringBuild(ids: BitId[]): Promise<buildHookResult[]> {
    const reportResults = await this.compile(ids.map(id => id.toString()));
    const resultsP: buildHookResult[] = reportResults.map(reportResult => {
      const id: BitId = reportResult.component.component.id._legacy;
      if (!reportResult.result || !reportResult.result.length) return { id };
      // @todo: check why this is an array and values are needed
      const distDir = reportResult.result[0].dir;
      if (!distDir) {
        throw new Error(
          `compile extension failed on ${id.toString()}, it expects to get "dir" as a result of executing the compilers`
        );
      }
      const distFiles = reportResult.component.capsule.fs.readdirSync(distDir);
      const distFilesObjects = distFiles.map(distFilePath => {
        const distPath = path.join(distDir, distFilePath);
        return {
          path: distPath,
          content: reportResult.component.capsule.fs.readFileSync(distPath).toString()
        };
      });
      return { id, dists: distFilesObjects };
    });
    return Promise.all(resultsP);
  }

  async compile(componentsIds: string[]): Promise<ReportResults[]> {
    const componentAndCapsules = await getComponentsAndCapsules(componentsIds, this.workspace);
    const idsAndScriptsArr = componentAndCapsules
      .map(c => {
        const compiler = c.component.config?.extensions?.compile?.compiler;
        return { id: c.consumerComponent.id, value: compiler ? [compiler] : [] };
      })
      .filter(i => i.value);
    const idsAndScripts = new IdsAndScripts(...idsAndScriptsArr);
    const resolvedComponents = await getResolvedComponents(componentsIds, this.workspace);
    return this.scripts.runMultiple(idsAndScripts, resolvedComponents);
  }

  async legacyCompile(componentsIds: string[], params: { verbose: boolean; noCache: boolean }) {
    const populateDistTask = this.populateComponentDist.bind(this, params);
    const writeDistTask = this.writeComponentDist.bind(this);
    await pipeRunTask(componentsIds, populateDistTask, this.workspace);
    return pipeRunTask(componentsIds, writeDistTask, this.workspace);
  }

  populateComponentDist(params: { verbose: boolean; noCache: boolean }, component: ComponentAndCapsule) {
    return buildComponent({
      component: component.consumerComponent,
      scope: this.workspace.consumer.scope,
      consumer: this.workspace.consumer,
      verbose: params.verbose,
      noCache: params.noCache
    });
  }

  async writeComponentDist(componentAndCapsule: ComponentAndCapsule) {
    const dataToPersist = new DataToPersist();
    const distsFiles = componentAndCapsule.consumerComponent.dists.get();
    distsFiles.map(d => d.updatePaths({ newBase: 'dist' }));
    dataToPersist.addManyFiles(distsFiles);
    await dataToPersist.persistAllToCapsule(componentAndCapsule.capsule);
    return distsFiles.map(d => d.path);
  }
}

function getBitIds(componentsIds: string[], workspace: Workspace): BitId[] {
  if (componentsIds.length) {
    return componentsIds.map(idStr => workspace.consumer.getParsedId(idStr));
  }
  return workspace.consumer.bitMap.getAuthoredAndImportedBitIds();
}

async function getResolvedComponents(componentsIds: string[], workspace: Workspace): Promise<ResolvedComponent[]> {
  const bitIds = getBitIds(componentsIds, workspace);
  return workspace.load(bitIds.map(id => id.toString()));
}

async function getComponentsAndCapsules(componentsIds: string[], workspace: Workspace): Promise<ComponentAndCapsule[]> {
  const resolvedComponents = await getResolvedComponents(componentsIds, workspace);
  return Promise.all(
    resolvedComponents.map(async (resolvedComponent: ResolvedComponent) => {
      // @todo: it says id._legacy "do not use this", do I have a better option to get the id?
      const consumerComponent = await workspace.consumer.loadComponent(resolvedComponent.component.id._legacy);
      return {
        consumerComponent,
        component: resolvedComponent.component,
        capsule: resolvedComponent.capsule
      };
    })
  );
}

async function pipeRunTask(ids: string[], task: Function, workspace: Workspace) {
  const components = await getComponentsAndCapsules(ids, workspace);
  const results = await Promise.all(components.map(component => task(component)));
  return { results, components };
}