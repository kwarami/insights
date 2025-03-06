import frappe

from insights.utils import deep_convert_dict_to_dict


def execute():
    if not frappe.db.count("Insights Workbook"):
        return

    frappe.reload_doc("insights", "doctype", "insights_query_v3")
    frappe.reload_doc("insights", "doctype", "insights_chart_v3")
    frappe.reload_doc("insights", "doctype", "insights_dashboard_v3")

    workbooks = frappe.get_all("Insights Workbook", pluck="name")

    for wb in workbooks:
        workbook = frappe.get_doc("Insights Workbook", wb)

        queries = frappe.parse_json(workbook.queries)
        charts = frappe.parse_json(workbook.charts)
        dashboards = frappe.parse_json(workbook.dashboards)

        query_name_to_doc = {}
        chart_name_to_doc = {}

        for query in queries:
            new_doc = frappe.new_doc("Insights Query v3")
            new_doc.update(query)
            new_doc.workbook = workbook.name
            new_doc.old_name = query["name"]
            new_doc.modified = workbook.modified
            new_doc.creation = workbook.creation
            new_doc.modified_by = workbook.modified_by
            new_doc.owner = workbook.owner
            new_doc.before_save()
            new_doc.db_insert()
            query_name_to_doc[query["name"]] = new_doc

        for chart in charts:
            chart = deep_convert_dict_to_dict(chart)

            new_doc = frappe.new_doc("Insights Chart v3")
            new_doc.workbook = workbook.name
            if chart.query in query_name_to_doc:
                new_doc.query = query_name_to_doc[chart.query].name
            new_doc.chart_type = chart.chart_type
            new_doc.title = chart.title
            new_doc.is_public = chart.is_public
            new_doc.config = frappe.as_json(chart.config)

            for op in chart.operations or []:
                if (
                    op.type == "source"
                    and op.table.type == "query"
                    and op.table.query_name in query_name_to_doc
                ):
                    op.table.query_name = query_name_to_doc[op.table.query_name].name

            new_doc.operations = frappe.as_json(chart.operations)
            new_doc.old_name = chart["name"]
            new_doc.modified = workbook.modified
            new_doc.creation = workbook.creation
            new_doc.modified_by = workbook.modified_by
            new_doc.owner = workbook.owner
            new_doc.before_save()
            new_doc.db_insert()
            chart_name_to_doc[chart["name"]] = new_doc

        for dashboard in dashboards:
            dashboard = deep_convert_dict_to_dict(dashboard)
            new_doc = frappe.new_doc("Insights Dashboard v3")
            new_doc.workbook = workbook.name
            new_doc.title = dashboard.title
            new_doc.preview_image = dashboard.preview_image
            new_doc.is_public = dashboard.is_public

            for item in dashboard["items"]:
                if item.type == "chart":
                    chart = chart_name_to_doc[item.chart]
                    item.chart = chart.name

                if item.type == "filter":
                    new_links = {}

                    item.links = item.links or {}
                    for chart_name, field in item.links.items():
                        if (
                            chart_name not in chart_name_to_doc
                            or not field
                            or "`.`" not in field
                        ):
                            continue

                        chart = chart_name_to_doc[chart_name]
                        field_query = field.split("`.`")[0].replace("`", "")
                        field_name = field.split("`.`")[1].replace("`", "")

                        if field_query not in query_name_to_doc:
                            continue

                        query_name = query_name_to_doc[field_query].name
                        new_links[chart.name] = f"`{query_name}`.`{field_name}`"

                    item.links = new_links

            new_doc.items = frappe.as_json(dashboard["items"])
            new_doc.old_name = dashboard["name"]
            new_doc.modified = workbook.modified
            new_doc.creation = workbook.creation
            new_doc.modified_by = workbook.modified_by
            new_doc.owner = workbook.owner
            new_doc.before_save()
            new_doc.db_insert()

        for query in query_name_to_doc.values():
            operations = deep_convert_dict_to_dict(frappe.parse_json(query.operations))
            if not operations:
                continue

            should_update = False
            for op in operations:
                if op.type != "source" and op.type != "join" and op.type != "union":
                    continue

                if op.table.type != "query":
                    continue

                ref_query = op.table.query_name
                if ref_query in query_name_to_doc:
                    op.table.query_name = query_name_to_doc[ref_query].name
                    should_update = True
                else:
                    print(
                        f"Query {ref_query} not found in workbook {query.name} for '{op.type}' operation"
                    )

            if should_update:
                query.operations = frappe.as_json(operations)
                query.save()
