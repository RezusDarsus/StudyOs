import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Each test gets a fresh DOM; a leaked tree makes "found multiple elements"
// failures that have nothing to do with the assertion being written.
afterEach(cleanup);

// jsdom implements no layout, so it ships neither of these. They are no-ops in a
// test but real behaviour in a browser, so stubbing beats guarding at every call
// site in the components.
Element.prototype.scrollTo ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
