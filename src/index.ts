import {
  AnyVariables,
  Exchange,
  Operation,
  TypedDocumentNode,
} from '@urql/core';
import {
  ASTNode,
  buildClientSchema,
  getNamedType,
  GraphQLInputType,
  IntrospectionQuery,
  isEnumType,
  isInputObjectType,
  isInputType,
  isScalarType,
  Kind,
  TypeInfo,
  visit,
  visitWithTypeInfo,
} from 'graphql';
import { DocumentNode, isNode } from 'graphql/language/ast';
import { map, pipe } from 'wonka';

type MapFunction = (input: any) => any;
export interface ScalarMapping {
  serialize?: MapFunction;
  deserialize?: MapFunction;
}

interface ScalarWithPath {
  /**
   * The name of the scalar
   */
  name: string;
  /**
   * The path to the scalar in the data returned from the server
   */
  path: PropertyKey[];
}

interface ScalarInNode extends ScalarWithPath {
  kind: 'scalar';
}
interface FragmentInNode {
  kind: 'fragment';
  fragmentName: string;
  path: PropertyKey[];
}
type NodeWithPath = ScalarInNode | FragmentInNode;

function identity<T>(value: T): T {
  return value;
}

function traverseAncestors(
  astPath: ReadonlyArray<number | string>,
  ancestorAstNodes: ReadonlyArray<ASTNode | readonly ASTNode[]>,
  callback: (node: ASTNode) => void
): void {
  let currentAstNode = ancestorAstNodes[0];
  astPath.forEach(segment => {
    // @ts-expect-error
    currentAstNode = currentAstNode[segment];
    if (isNode(currentAstNode)) {
      callback(currentAstNode);
    }
  });
}

function getPathAndFragmentName(
  astPath: ReadonlyArray<number | string>,
  ancestorAstNodes: ReadonlyArray<ASTNode | readonly ASTNode[]>
): [PropertyKey[], string | undefined] {
  const path: PropertyKey[] = [];
  let fragmentName: string | undefined;
  traverseAncestors(astPath, ancestorAstNodes, node => {
    if (node.kind === Kind.FIELD) {
      if (node.alias) {
        path.push(node.alias.value);
      } else {
        path.push(node.name.value);
      }
    } else if (node.kind === Kind.FRAGMENT_DEFINITION) {
      fragmentName = node.name.value;
    }
  });

  return [path, fragmentName];
}

function mapScalar(
  data: any,
  path: PropertyKey[],
  mapping: MapFunction = identity
) {
  if (data == null) {
    return data;
  }

  const newData = { ...data };

  let newSubData = newData;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    if (Array.isArray(newSubData[segment])) {
      const subPath = path.slice(index + 1);
      newSubData[segment] = newSubData[segment].map((subData: unknown) =>
        mapScalar(subData, subPath, mapping)
      );
      return newData;
    } else if (newSubData[segment] == null) {
      return newData;
    } else {
      newSubData[segment] = { ...newSubData[segment] };
    }
    newSubData = newSubData[segment];
  }

  const finalSegment = path[path.length - 1];

  if (Array.isArray(newSubData[finalSegment])) {
    newSubData[finalSegment] = newSubData[finalSegment].map(mapping);
  } else if (newSubData[finalSegment] != null) {
    newSubData[finalSegment] = mapping(newSubData[finalSegment]);
  }

  return newData;
}

interface ScalarExchangeOptions {
  scalars: Record<string, ScalarMapping>;
  schema: IntrospectionQuery;
}

function handleNever(value: never): never {
  return value;
}

export default function scalarExchange({
  schema,
  scalars,
}: ScalarExchangeOptions): Exchange {
  const clientSchema = buildClientSchema(schema);
  const typeInfoInstance = new TypeInfo(clientSchema);

  const getScalarsInInput = (
    query: DocumentNode | TypedDocumentNode<any, AnyVariables>
  ): ScalarWithPath[] => {
    const resolveScalarsInInputType = (
      inputType: GraphQLInputType,
      visitedInputObjectTypeNames: string[] = []
    ): ScalarWithPath[] => {
      const variableType = getNamedType(inputType);
      if (visitedInputObjectTypeNames.includes(variableType.name)) {
        // There's a cycle in the variable input types; we should do something here but not error (because it's technically legal).
        return [];
      }

      if (isScalarType(variableType)) {
        if (scalars[variableType.name]?.serialize) {
          return [{ name: variableType.name, path: [] }];
        }
        return [];
      } else if (isEnumType(variableType)) {
        return [];
      } else if (isInputObjectType(variableType)) {
        const scalarsInInputObjectType: ScalarWithPath[] = [];
        Object.values(variableType.getFields()).forEach(({ name, type }) => {
          const newScalars: ScalarWithPath[] = resolveScalarsInInputType(type, [
            ...visitedInputObjectTypeNames,
            variableType.name,
          ]).map(scalarWithPath => ({
            ...scalarWithPath,
            path: [name, ...scalarWithPath.path],
          }));
          scalarsInInputObjectType.push(...newScalars);
        });
        return scalarsInInputObjectType;
      }

      return handleNever(variableType);
    };

    const scalarsInInputs: ScalarWithPath[] = [];
    const visitor = visitWithTypeInfo(typeInfoInstance, {
      VariableDefinition(node) {
        const variableTypeNode = node.type;
        visit(variableTypeNode, {
          NamedType(variableNameNode) {
            const variableType = clientSchema.getType(
              variableNameNode.name.value
            );
            if (variableType == null || !isInputType(variableType)) {
              return;
            }

            const newScalars: ScalarWithPath[] = resolveScalarsInInputType(
              variableType
            ).map(scalarWithPath => ({
              ...scalarWithPath,
              path: [node.variable.name.value, ...scalarWithPath.path],
            }));
            scalarsInInputs.push(...newScalars);
          },
        });
      },
    });
    visit(query, visitor);
    return scalarsInInputs;
  };

  const getScalarsInQuery = (
    query: DocumentNode | TypedDocumentNode<any, AnyVariables>
  ): ScalarWithPath[] => {
    const nodesInQuery: NodeWithPath[] = [];
    // Keyed by fragment name.
    const nodesInFragments: Partial<Record<string, NodeWithPath[]>> = {};

    const visitor = visitWithTypeInfo(typeInfoInstance, {
      Field(_node, _key, _parent, astPath, ancestorAstNodes) {
        const fieldType = typeInfoInstance.getType();
        if (fieldType == null) {
          return;
        }

        const scalarType = getNamedType(fieldType);
        if (!isScalarType(scalarType)) {
          return;
        }

        const { name } = scalarType;
        if (scalars[name]?.deserialize == null) {
          return;
        }

        const [path, fragmentName] = getPathAndFragmentName(
          astPath,
          ancestorAstNodes
        );

        const scalarInNode: ScalarInNode = { kind: 'scalar', name, path };
        if (fragmentName == null) {
          nodesInQuery.push(scalarInNode);
        } else {
          nodesInFragments[fragmentName] = nodesInFragments[fragmentName] ?? [];
          nodesInFragments[fragmentName]!.push(scalarInNode);
        }
      },
      FragmentSpread(node, _key, _parent, astPath, ancestorAstNodes) {
        const [path, fragmentName] = getPathAndFragmentName(
          astPath,
          ancestorAstNodes
        );

        const fragmentInNode: FragmentInNode = {
          kind: 'fragment',
          fragmentName: node.name.value,
          path,
        };
        if (fragmentName == null) {
          nodesInQuery.push(fragmentInNode);
        } else {
          nodesInFragments[fragmentName] = nodesInFragments[fragmentName] ?? [];
          nodesInFragments[fragmentName]!.push(fragmentInNode);
        }
      },
    });
    visit(query, visitor);

    // Keyed by fragment name.
    const resolvedScalarsInFragments: Record<string, ScalarWithPath[]> = {};
    const resolveScalarsInFragment = (
      fragmentName: string,
      visitedFragmentNames: string[] = []
    ): ScalarWithPath[] => {
      if (resolvedScalarsInFragments[fragmentName]) {
        return resolvedScalarsInFragments[fragmentName];
      }

      if (visitedFragmentNames.includes(fragmentName)) {
        // There's a cycle in the nested fragments; we should do something here but not error (because it's technically legal).
        return [];
      }

      const scalarsInFragment: ScalarWithPath[] = [];
      nodesInFragments[fragmentName]?.forEach(nodeWithPath => {
        if (nodeWithPath.kind === 'scalar') {
          scalarsInFragment.push(nodeWithPath);
        } else if (nodeWithPath.kind === 'fragment') {
          const newScalars: ScalarWithPath[] = resolveScalarsInFragment(
            nodeWithPath.fragmentName,
            [...visitedFragmentNames, fragmentName]
          ).map(scalarWithPath => ({
            ...scalarWithPath,
            path: [...nodeWithPath.path, ...scalarWithPath.path],
          }));
          scalarsInFragment.push(...newScalars);
        } else {
          handleNever(nodeWithPath);
        }
      });
      resolvedScalarsInFragments[fragmentName] = scalarsInFragment;
      return scalarsInFragment;
    };

    const scalarsInQuery: ScalarWithPath[] = [];
    nodesInQuery.forEach(nodeWithPath => {
      if (nodeWithPath.kind === 'scalar') {
        scalarsInQuery.push(nodeWithPath);
      } else if (nodeWithPath.kind === 'fragment') {
        const newScalars: ScalarWithPath[] = resolveScalarsInFragment(
          nodeWithPath.fragmentName
        ).map(scalarWithPath => ({
          ...scalarWithPath,
          path: [...nodeWithPath.path, ...scalarWithPath.path],
        }));
        scalarsInQuery.push(...newScalars);
      } else {
        handleNever(nodeWithPath);
      }
    });
    return scalarsInQuery;
  };

  return ({ forward }) => (operations$: any) => {
    const operationResult$ = pipe(
      operations$,
      map((operation: Operation) => {
        const scalarsInInputs = getScalarsInInput(operation.query);
        if (scalarsInInputs.length === 0) {
          return operation;
        }

        scalarsInInputs.forEach(({ name, path }) => {
          operation.variables = mapScalar(
            operation.variables,
            path,
            scalars[name]?.serialize
          );
        });
        return operation;
      }),
      forward
    );

    return pipe(
      operationResult$,
      map(args => {
        if (args.data == null) {
          return args;
        }

        const scalarsInQuery = getScalarsInQuery(args.operation.query);
        if (scalarsInQuery.length === 0) {
          return args;
        }

        scalarsInQuery.forEach(({ name, path }) => {
          args.data = mapScalar(args.data, path, scalars[name]?.deserialize);
        });
        return args;
      })
    );
  };
}
