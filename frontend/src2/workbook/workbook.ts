import { watchDebounced } from '@vueuse/core'
import { call } from 'frappe-ui'
import { computed, InjectionKey, reactive, ref, toRefs } from 'vue'
import useChart, { newChart } from '../charts/chart'
import useDashboard, { newDashboard } from '../dashboard/dashboard'
import { copy, getUniqueId, safeJSONParse, showErrorToast, wheneverChanges } from '../helpers'
import { confirmDialog } from '../helpers/confirm_dialog'
import useDocumentResource from '../helpers/resource'
import useQuery, { newQuery } from '../query/query'
import router from '../router'
import session from '../session'
import type {
	InsightsWorkbook,
	WorkbookSharePermission as WorkbookUserPermission,
} from '../types/workbook.types'

const workbooks = new Map<string, Workbook>()

export default function useWorkbook(name: string) {
	name = String(name)
	const existingWorkbook = workbooks.get(name)
	if (existingWorkbook) return existingWorkbook

	const workbook = makeWorkbook(name)
	workbooks.set(name, workbook)
	return workbook
}

function makeWorkbook(name: string) {
	const workbook = getWorkbookResource(name)

	// getLinkedQueries expects the query to be loaded
	wheneverChanges(
		() => workbook.doc.queries.map((q) => q.name),
		() => workbook.doc.queries.forEach((q) => useQuery(q.name)),
		{ deep: true }
	)

	function setActiveTab(type: 'query' | 'chart' | 'dashboard', name: string) {
		router.replace(`/workbook/${workbook.name}/${type}/${name}`)
	}
	function isActiveTab(type: 'query' | 'chart' | 'dashboard', name: string) {
		const url = router.currentRoute.value.path
		const regex = new RegExp(`/workbook/${workbook.name}/${type}/${name}`)
		return regex.test(url)
	}

	async function addQuery() {
		const query = newQuery()
		query.doc.title = 'Query ' + (workbook.doc.queries.length + 1)
		query.doc.workbook = workbook.doc.name
		query.doc.use_live_connection = true
		query.insert().then(() => {
			workbook.doc.queries.push({
				name: query.doc.name,
				title: query.doc.title,
			})
			setActiveTab('query', query.doc.name)
		})
	}

	function removeQuery(name: string) {
		function _remove() {
			const queryIndex = workbook.doc.queries.findIndex((row) => row.name === name)
			if (queryIndex === -1) return

			const query = useQuery(name)
			query.delete().then(() => {
				workbook.doc.queries.splice(queryIndex, 1)
			})

			const nextQueryIndex = queryIndex - 1
			if (nextQueryIndex >= 0) {
				setActiveTab('query', workbook.doc.queries[nextQueryIndex].name)
			} else {
				router.replace(`/workbook/${workbook.name}`)
			}
		}

		confirmDialog({
			title: 'Delete Query',
			message: 'Are you sure you want to delete this query?',
			onSuccess: _remove,
		})
	}

	function addChart(query_name?: string) {
		const chart = newChart()
		chart.doc.title = 'Chart ' + (workbook.doc.charts.length + 1)
		chart.doc.workbook = workbook.doc.name
		chart.doc.query = query_name || ''
		chart.doc.chart_type = 'Bar'
		chart.insert().then(() => {
			workbook.doc.charts.push({
				name: chart.doc.name,
				title: chart.doc.title,
				query: chart.doc.query,
				chart_type: 'Bar',
			})
			setActiveTab('chart', chart.doc.name)
		})
	}

	function removeChart(chartName: string) {
		function _remove() {
			const idx = workbook.doc.charts.findIndex((row) => row.name === chartName)
			if (idx === -1) return
			const chart = useChart(chartName)
			chart.delete().then(() => {
				workbook.doc.charts.splice(idx, 1)
			})

			const nextChartIndex = idx - 1
			if (nextChartIndex >= 0) {
				setActiveTab('chart', workbook.doc.charts[nextChartIndex].name)
			} else {
				router.replace(`/workbook/${workbook.name}`)
			}
		}

		confirmDialog({
			title: 'Delete Chart',
			message: 'Are you sure you want to delete this chart?',
			onSuccess: _remove,
		})
	}

	function addDashboard() {
		const dashboard = newDashboard()
		dashboard.doc.title = 'Dashboard ' + (workbook.doc.dashboards.length + 1)
		dashboard.doc.workbook = workbook.doc.name
		dashboard.insert().then(() => {
			workbook.doc.dashboards.push({
				name: dashboard.doc.name,
				title: dashboard.doc.title,
			})
			setActiveTab('dashboard', dashboard.doc.name)
		})
	}

	function removeDashboard(dashboardName: string) {
		function _remove() {
			const idx = workbook.doc.dashboards.findIndex((row) => row.name === dashboardName)
			if (idx === -1) return
			const dashboard = useDashboard(dashboardName)
			dashboard.delete().then(() => {
				workbook.doc.dashboards.splice(idx, 1)
			})

			const nextDashboardIndex = idx - 1
			if (nextDashboardIndex >= 0) {
				setActiveTab('dashboard', workbook.doc.dashboards[nextDashboardIndex].name)
			} else {
				router.replace(`/workbook/${workbook.name}`)
			}
		}

		confirmDialog({
			title: 'Delete Dashboard',
			message: 'Are you sure you want to delete this dashboard?',
			onSuccess: _remove,
		})
	}

	const isOwner = computed(() => workbook.doc.owner === session.user?.email)
	const canShare = computed(() => isOwner.value)

	async function getSharePermissions(): Promise<UpdateSharePermissionsArgs> {
		const method = 'insights.api.workbooks.get_share_permissions'
		return call(method, { workbook_name: workbook.name }).then((permissions: any) => {
			return {
				user_permissions: permissions.user_permissions.map((p: any) => {
					return {
						email: p.user,
						full_name: p.full_name,
						access: p.read ? (p.write ? 'edit' : 'view') : undefined,
					}
				}),
				organization_access: permissions.organization_access,
			}
		})
	}

	type UpdateSharePermissionsArgs = {
		user_permissions: WorkbookUserPermission[]
		organization_access?: 'view' | 'edit'
	}
	async function updateSharePermissions(args: UpdateSharePermissionsArgs) {
		const method = 'insights.api.workbooks.update_share_permissions'
		return call(method, {
			workbook_name: workbook.name,
			organization_access: args.organization_access,
			user_permissions: args.user_permissions.map((p) => {
				return {
					user: p.email,
					read: p.access === 'view',
					write: p.access === 'edit',
				}
			}),
		}).catch(showErrorToast)
	}

	function deleteWorkbook() {
		confirmDialog({
			title: 'Delete Workbook',
			message: 'Are you sure you want to delete this workbook?',
			theme: 'red',
			onSuccess: () => {
				workbook.delete().then(() => {
					router.replace('/workbook')
				})
			},
		})
	}

	let stopAutoSaveWatcher: any
	const _pauseAutoSave = ref(false)
	wheneverChanges(
		() => workbook.doc.enable_auto_save,
		() => {
			if (!workbook.doc.enable_auto_save && stopAutoSaveWatcher) {
				stopAutoSaveWatcher()
				stopAutoSaveWatcher = null
			}
			if (workbook.doc.enable_auto_save && !stopAutoSaveWatcher) {
				stopAutoSaveWatcher = watchDebounced(
					() => workbook.isdirty && !_pauseAutoSave.value,
					(shouldSave) => shouldSave && workbook.save(),
					{ immediate: true, debounce: 2000 }
				)
			}
		}
	)

	return reactive({
		...toRefs(workbook),
		canShare,
		isOwner,

		showSidebar: true,
		_pauseAutoSave,

		isActiveTab,

		addQuery,
		removeQuery,

		addChart,
		removeChart,

		addDashboard,
		removeDashboard,

		getSharePermissions,
		updateSharePermissions,

		getLinkedQueries,

		delete: deleteWorkbook,
	})
}

export type Workbook = ReturnType<typeof makeWorkbook>
export const workbookKey = Symbol() as InjectionKey<Workbook>

export function getWorkbookResource(name: string) {
	const doctype = 'Insights Workbook'
	const workbook = useDocumentResource<InsightsWorkbook>(doctype, name, {
		initialDoc: {
			doctype,
			name,
			owner: '',
			title: '',
			queries: [],
			charts: [],
			dashboards: [],
		},
		enableAutoSave: true,
		disableLocalStorage: true,
		transform(doc: any) {
			doc.queries = safeJSONParse(doc.queries) || []
			doc.charts = safeJSONParse(doc.charts) || []
			doc.dashboards = safeJSONParse(doc.dashboards) || []
			return doc
		},
	})

	workbook.onAfterLoad(() => workbook.call('track_view').catch(() => {}))
	return workbook
}

export function newWorkbookName() {
	const unique_id = getUniqueId()
	return `new-workbook-${unique_id}`
}

export function getLinkedQueries(query_name: string): string[] {
	const query = useQuery(query_name)
	const linkedQueries = new Set<string>()

	if (!query.isloaded) {
		console.log('Operations not loaded yet for query', query_name)
	}

	const operations = copy(query.currentOperations)
	if (query.activeEditIndex > -1) {
		operations.splice(query.activeEditIndex)
	}

	operations.forEach((op) => {
		if ('table' in op && 'type' in op.table && op.table.type === 'query') {
			linkedQueries.add(op.table.query_name)
		}
	})

	linkedQueries.forEach((q) => getLinkedQueries(q).forEach((q) => linkedQueries.add(q)))

	return Array.from(linkedQueries)
}
