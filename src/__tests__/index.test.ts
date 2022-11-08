import {
  ExchangeIO,
  Operation,
  OperationResult,
  createClient,
} from '@urql/core';
import { DocumentNode, IntrospectionQuery } from 'graphql';
import gql from 'graphql-tag';
import { pipe, map, makeSubject, publish, tap } from 'wonka';

import scalarExchange, { ScalarMapping } from '../';
import schema from './__fixtures__/schema.json';

interface TestCase {
  name: string;
  query: DocumentNode;
  variables?: {};
  data: {};
  serializeCalls?: number;
  deserializeCalls: number;
}

const dispatchDebug = jest.fn();

let client = createClient({ url: 'http://0.0.0.0' });
let { source: ops$, next } = makeSubject<Operation>();

beforeEach(() => {
  client = createClient({ url: 'http://0.0.0.0' });
  ({ source: ops$, next } = makeSubject<Operation>());
});

const simpleData = 'a';
const nestedData = { name: 'a' };

const simple: TestCase = {
  name: 'simple',
  query: gql`
    {
      simple
    }
  `,
  data: { simple: simpleData },
  deserializeCalls: 1,
};

const nested: TestCase = {
  name: 'nested',
  query: gql`
    {
      nested {
        name
      }
    }
  `,
  data: { nested: nestedData },
  deserializeCalls: 1,
};

const nestedNullable: TestCase = {
  name: 'nestedNullable',
  query: gql`
    {
      nestedNullable {
        name
      }
    }
  `,
  data: { nestedNullable: null },
  deserializeCalls: 0,
};

const list: TestCase = {
  name: 'list',
  query: gql`
    {
      list
    }
  `,
  data: { list: [simpleData, simpleData] },
  deserializeCalls: 2,
};

const listWithInput: TestCase = {
  name: 'listWithInput',
  query: gql`
    query ListWithInput($input: String) {
      list(input: $input)
    }
  `,
  variables: { input: 'topInput' },
  data: { list: [simpleData, simpleData] },
  serializeCalls: 1,
  deserializeCalls: 2,
};

const listNested: TestCase = {
  name: 'listNested',
  query: gql`
    {
      listNested {
        name
      }
    }
  `,
  data: { listNested: [nestedData, nestedData] },
  deserializeCalls: 2,
};

const listNestedNullable: TestCase = {
  name: 'listNestedNullable',
  query: gql`
    {
      listNestedNullable {
        name
      }
    }
  `,
  data: { listNestedNullable: null },
  deserializeCalls: 0,
};

const listNestedWithInput: TestCase = {
  name: 'listNestedWithInput',
  query: gql`
    query ListNestedWithInput($input: ListInput) {
      listNested(input: $input) {
        name
      }
    }
  `,
  variables: {
    input: { topInput: 'topInput', nested: { nestedInput: 'nestedInput' } },
  },
  data: { listNested: [nestedData, nestedData] },
  serializeCalls: 2,
  deserializeCalls: 2,
};

const fragment1: TestCase = {
  name: 'fragment1',
  query: gql`
    {
      ...QueryFields
    }

    fragment QueryFields on Query {
      listNested {
        name
      }
    }
  `,
  data: { listNested: [nestedData] },
  deserializeCalls: 1,
};

const fragment2: TestCase = {
  name: 'fragment2',
  query: gql`
    {
      listNested {
        ...ListFields
      }
    }

    fragment ListFields on Nested {
      name
    }
  `,
  data: { listNested: [nestedData, nestedData] },
  deserializeCalls: 2,
};

const repeatedFragment: TestCase = {
  name: 'repeatedFragment',
  query: gql`
    fragment SomeFragment on Nested {
      name
    }

    {
      first: nested {
        ...SomeFragment
      }

      second: nested {
        ...SomeFragment
      }
    }
  `,
  data: { first: nestedData, second: nestedData },
  deserializeCalls: 2,
};

const nestedFragment: TestCase = {
  name: 'nestedFragment',
  query: gql`
    query {
      listNested {
        ...nested1
      }
    }
    fragment nested1 on Nested {
      name
      deeplyNested {
        ...nested2
      }
    }
    fragment nested2 on Nested {
      name
    }
  `,
  data: {
    listNested: [
      {
        name: 'firstLevel',
        deeplyNested: {
          name: 'secondLevel',
        },
      },
    ],
  },
  deserializeCalls: 2,
};

const TEST_CASES: TestCase[] = [
  fragment1,
  fragment2,
  list,
  listWithInput,
  listNested,
  listNestedNullable,
  listNestedWithInput,
  nested,
  nestedNullable,
  repeatedFragment,
  simple,
  nestedFragment,
];

TEST_CASES.forEach(
  ({ name, query, variables, data, serializeCalls, deserializeCalls }) => {
    it(`works on the ${name} structure`, () => {
      const op = client.createRequestOperation('query', {
        key: 1,
        query,
        variables,
      });

      const response = jest.fn(
        (forwardOp: Operation): OperationResult => {
          expect(forwardOp.key === op.key).toBeTruthy();
          if (variables != null) {
            expect(forwardOp.variables).toMatchSnapshot('Variables');
          }
          return {
            operation: forwardOp,
            data: { __typename: 'Query', ...data },
          };
        }
      );
      const result = jest.fn();
      const forward: ExchangeIO = ops$ => pipe(ops$, map(response));

      const stringSerializer = jest.fn((text: String) =>
        text.split('').join(' ')
      );
      const stringDeserializer = jest.fn((text: string) => text.toUpperCase());
      const scalars: Record<string, ScalarMapping> = {
        String: {
          serialize: stringSerializer,
          deserialize: stringDeserializer,
        },
      };

      pipe(
        scalarExchange({
          schema: (schema as unknown) as IntrospectionQuery,
          scalars,
        })({
          forward,
          client,
          dispatchDebug,
        })(ops$),
        map(operationResult => {
          expect(operationResult.data).toMatchSnapshot('Output');
          return operationResult;
        }),
        tap(result),
        publish
      );

      next(op);

      if (serializeCalls != null) {
        expect(stringSerializer).toHaveBeenCalledTimes(serializeCalls);
      }
      expect(stringDeserializer).toHaveBeenCalledTimes(deserializeCalls);
      expect(result).toHaveBeenCalledTimes(1);
    });
  }
);
