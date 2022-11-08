import {
  ExchangeIO,
  Operation,
  OperationResult,
  createClient,
} from '@urql/core';
import { DocumentNode, IntrospectionQuery } from 'graphql';
import gql from 'graphql-tag';
import { pipe, map, makeSubject, publish, tap } from 'wonka';

import scalarExchange from '../';
import schema from './__fixtures__/schema.json';

interface TestCase {
  query: DocumentNode;
  variables?: {};
  data: {};
  calls: number;
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
  query: gql`
    {
      simple
    }
  `,
  data: { simple: simpleData },
  calls: 1,
};

const nested: TestCase = {
  query: gql`
    {
      nested {
        name
      }
    }
  `,
  data: { nested: nestedData },
  calls: 1,
};

const nestedNullable: TestCase = {
  query: gql`
    {
      nestedNullable {
        name
      }
    }
  `,
  data: { nestedNullable: null },
  calls: 0,
};

const list: TestCase = {
  query: gql`
    {
      list
    }
  `,
  data: { list: [simpleData, simpleData] },
  calls: 2,
};

const listNested: TestCase = {
  query: gql`
    {
      listNested {
        name
      }
    }
  `,
  data: { listNested: [nestedData, nestedData] },
  calls: 2,
};

const listNestedNullable: TestCase = {
  query: gql`
    {
      listNestedNullable {
        name
      }
    }
  `,
  data: { listNestedNullable: null },
  calls: 0,
};

const listNestedWithInput: TestCase = {
  query: gql`
    {
      listNested(input: $input) {
        name
      }
    }
  `,
  variables: { input: { topInput: 'topInput' } },
  data: { listNested: [nestedData, nestedData] },
  calls: 2,
};

const fragment1: TestCase = {
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
  calls: 1,
};

const fragment2: TestCase = {
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
  calls: 2,
};

const repeatedFragment: TestCase = {
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
  calls: 2,
};

const nestedFragment: TestCase = {
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
  calls: 2,
};

const TEST_CASES: TestCase[] = [
  fragment1,
  fragment2,
  list,
  listNested,
  listNestedNullable,
  listNestedWithInput,
  nested,
  nestedNullable,
  repeatedFragment,
  simple,
  nestedFragment,
];

test.each(TEST_CASES)(
  'works on different structures',
  ({ query, variables, data, calls }) => {
    const op = client.createRequestOperation('query', {
      key: 1,
      query,
      variables,
    });

    const response = jest.fn(
      (forwardOp: Operation): OperationResult => {
        expect(forwardOp.key === op.key).toBeTruthy();
        expect(forwardOp.variables).toMatchSnapshot('Variables');
        return {
          operation: forwardOp,
          data: { __typename: 'Query', ...data },
        };
      }
    );
    const result = jest.fn();
    const forward: ExchangeIO = ops$ => pipe(ops$, map(response));

    const scalars = {
      String: jest.fn((text: string) => {
        return text.toUpperCase();
      }),
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

    expect(scalars.String).toHaveBeenCalledTimes(calls);
    expect(result).toHaveBeenCalledTimes(1);
  }
);
