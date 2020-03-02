import { Graph } from 'graphlib';
import { ExecutionOptions } from '../network/options';
import { ComponentID, Component } from '../../component';
import { GetFlow, Network } from '../network';
import { BitId } from '../../../bit-id';
import { Consumer } from '../../../consumer';
import { Workspace } from '../../..';
import { getFakeCapsuleLocation, createFakeCapsule } from './create-capsule';

export type GraphTestCase = {
  graph: { [id: string]: string[] };
  input: string[];
  options: ExecutionOptions;
};

export async function createTestNetworkStream(testCase: GraphTestCase) {
  const fakeGetGraph = createGetGraphFn(testCase);
  const fakeWorkSpace = createFakeWorkSpace(fakeGetGraph);
  const ids = testCase.input.map(val => new ComponentID(BitId.parse(val)));
  const getFlow = {} as GetFlow;
  const network = new Network(fakeWorkSpace, ids, getFlow, fakeGetGraph);
  return network.execute(testCase.options);
}

function createFakeWorkSpace(fakeGetGraph: (_consumer: Consumer) => Promise<Graph>) {
  return {
    getMany: (ids: Array<BitId | string>) => {
      return Promise.resolve(
        ids.map(id => {
          return {
            id: {
              toString: () => id
            }
          } as Component;
        })
      );
    },
    loadCapsules: async (ids: string[]) => {
      const graph = await fakeGetGraph({} as Consumer);
      return Promise.all(ids.map(id => createFakeCapsuleInGraph(id, graph)));
    }
  } as Workspace;
}

export function createGetGraphFn(testCase: GraphTestCase) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (_consumer: Consumer) => {
    const res = Object.entries(testCase.graph).reduce((accum, [key, value]) => {
      accum.setNode(key);
      value.forEach(val => {
        accum.setNode(val);
        accum.setEdge(key, val);
      });
      return accum;
    }, new Graph());

    return Promise.resolve(res);
  };
}

async function createFakeCapsuleInGraph(name: string, graph: Graph) {
  const main = 'src/index.js';
  const dependencies = (graph.predecessors(name) || []).reduce((accum, dependency) => {
    accum[dependency] = `file://${getFakeCapsuleLocation(name)}`;
    return accum;
  }, {});

  const fs = {
    [main]: `
      ${Object.keys(dependencies)
        .map(dependency => `const ${dependency} = require('${dependency}')`)
        .join('\n')}
      function printMe(){
        console.log('${Object.keys(dependencies)
          .map(dependency => `${dependency}()` || ['hello', 'world'])
          .join('+')}')
      }

      module.exports = function () {
        return '${name}'
      }
    `,
    'package.json': JSON.stringify({ main, name, dependencies }, null, 2)
  };

  const fakeCapsule = await createFakeCapsule(fs, name);
  return fakeCapsule;
}
