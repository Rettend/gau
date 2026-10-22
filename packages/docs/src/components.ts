/**
 * MDX globals and the public component barrel for docs content.
 *
 * `components` is installed as the MDX component registry in
 * `[...slug].astro`. Named exports let pages import the same implementations
 * explicitly, which keeps TypeScript aware of their props.
 */

import IconLink from './components/IconLink.astro'
import IconLinkGroup from './components/IconLinkGroup.astro'
import { Aside } from './components/ui/aside'
import { Card } from './components/ui/card'
import { CardGrid } from './components/ui/card-grid'
import { FileTree } from './components/ui/file-tree'
import { PackageManagers } from './components/ui/package-managers'
import { Step, Steps } from './components/ui/steps'
import { TabItem, Tabs } from './components/ui/tabs'

export { Aside, Card, CardGrid, FileTree, IconLink, IconLinkGroup, PackageManagers, Step, Steps, TabItem, Tabs }

export const components = {
  Aside,
  Card,
  CardGrid,
  FileTree,
  IconLink,
  IconLinkGroup,
  PackageManagers,
  Step,
  Steps,
  TabItem,
  Tabs,
}
